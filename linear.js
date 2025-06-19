import axios from 'axios';
import dotenv from 'dotenv';
import { authorize } from './auth.js';
import { google } from 'googleapis';
import { SocksProxyAgent } from 'socks-proxy-agent';

dotenv.config();

const proxyUrl = process.env.PROXY_URL;
const agent = new SocksProxyAgent(proxyUrl);

const LINEAR_API_TOKEN = process.env.LINEAR_API_TOKEN;
const TEAM_ID = process.env.LINEAR_TEAM_ID;
const STATUS_NAME = process.env.LINEAR_STATUS_NAME;
const SHEET_ID = process.env.TARGET_SHEET_ID;
const SHEET_NAME = 'Должники';

export async function getStatusId() {
  const query = `
    query GetWorkflowStates($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
          }
        }
      }
    }`;

  const variables = { teamId: TEAM_ID };

  const response = await axios.post(
    'https://api.linear.app/graphql',
    { query, variables },
    {
      headers: {
        Authorization: LINEAR_API_TOKEN,
        'Content-Type': 'application/json',
      },
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 10000,
    }
  );

  const states = response.data.data.team.states.nodes;
  const match = states.find(s => s.name === STATUS_NAME);

  if (!match) throw new Error(`Status '${STATUS_NAME}' not found in team '${TEAM_ID}'`);
  return match.id;
}

export async function createLinearIssue(title, description) {
  const stateId = await getStatusId();

  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          title
        }
      }
    }`;

  const variables = {
    input: {
      teamId: TEAM_ID,
      title,
      description,
      stateId,
    },
  };

  const response = await axios.post(
    'https://api.linear.app/graphql',
    { query: mutation, variables },
    {
      headers: {
        Authorization: LINEAR_API_TOKEN,
        'Content-Type': 'application/json',
      },
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 10000,
    }
  );

  const result = response.data;
  if (!result.data.issueCreate.success) {
    throw new Error('Failed to create issue: ' + JSON.stringify(result.errors));
  }

  console.log('✅ Linear issue created:', result.data.issueCreate.issue.id);
  return result.data.issueCreate.issue;
}

export async function notifyDebtors() {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });
  const range = SHEET_NAME + '!A1:L';

  const metaRes = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const targetSheet = metaRes.data.sheets.find(s => s.properties.title === SHEET_NAME);
  const sheetId = targetSheet.properties.sheetId;

  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: range,
  });
  const rows = valuesRes.data.values;
  const data = rows.slice(1);

  const formatRes = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    ranges: [range],
    includeGridData: true,
  });
  const gridData = formatRes.data.sheets.find(s => s.properties.sheetId === sheetId).data[0].rowData;

  const relevantRows = data;

  const sorted = [...relevantRows].sort((a, b) => {
  const hasA = (a[0] || '').startsWith('@');
  const hasB = (b[0] || '').startsWith('@');

  if (hasA && !hasB) return -1;
  if (!hasA && hasB) return 1;

  const nameA = (a[0] || '').toLowerCase();
  const nameB = (b[0] || '').toLowerCase();
  return nameA.localeCompare(nameB);
});

  const entries = sorted.map(row => {
    const responsible = row[0]
      ? row[0].startsWith('@')
        ? row[0]
        : `@${row[0]}`
      : '';
    const id = row[1] || '';
    const company = row[2] || '';
    const over = row[7] ? `+${row[7]} лицензий` : '';
    const months = parseInt(row[11] || '0');
    const mark = months === 2 ? '🟨' : months > 2 ? '🟥' : '';
    return `${responsible} ${id} ${company} | ${over} ${mark}`.trim();
  });

  const description = `
[Таблица](https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${sheetId}#gid=${sheetId})

${entries.join('\n')}
  `.trim();

  await createLinearIssue('Написать должникам', description);
}
