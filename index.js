import { google } from 'googleapis';
import { authorize } from './auth.js';
import { fetchMetabaseData } from './metabase.js';
import { notifyDebtors } from './linear.js';
import dotenv from 'dotenv';

dotenv.config();

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID;
const TARGET_SHEET_ID = process.env.TARGET_SHEET_ID;
const SOURCE_SHEET_NAME = 'Платящие';
const TARGET_SHEET_NAME = 'Должники';
const METABASE_QUESTION_ID = 648;

function getLightYellow() {
  return { red: 1, green: 0.9764706, blue: 0.76862746 };
}

function parseDate(str) {
  if (!str || typeof str !== 'string') return null;
  const [day, month, year] = str.split('.');
  const fullYear = year.length === 2 ? '20' + year : year;
  return new Date(`${fullYear}-${month}-${day}`);
}

export async function main() {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SOURCE_SHEET_ID,
    range: `${SOURCE_SHEET_NAME}!A1:W`,
  });
  const rows = res.data.values;
  if (!rows || rows.length < 2) return console.log('Нет данных');
  const data = rows.slice(1);

  const companies = data
    .filter(row => row[12] === 'Компания')
    .map(row => ({
      responsible: row[22],
      company_id: row[0],
      name: row[1],
      paid_licenses: row[3],
      active_employees: row[9],
      payment_method: row[20],
      payment_date: row[19],
      license_price: row[13],
    }));

  const metabaseData = await fetchMetabaseData(METABASE_QUESTION_ID);
  const metabaseMap = Object.fromEntries(
    metabaseData.map(entry => [String(entry.id).replace(/,/g, ''), entry])
  );

  const final = companies.map(c => {
    const m = metabaseMap[c.company_id] || {};
    const over = +c.active_employees - +c.paid_licenses;
    return {
      responsible: c.responsible,
      company_id: c.company_id,
      name: c.name,
      email: m.email || '',
      phone: m.phone_number || '',
      paid_licenses: c.paid_licenses,
      active_employees: c.active_employees,
      overage: over,
      payment_method: c.payment_method,
      payment_date: c.payment_date,
      license_price: c.license_price,
    };
  }).filter(c => {
    const paid = Number(c.paid_licenses || 0);
    return c.overage >= 10 && paid > 0;
  }).sort((a, b) => b.overage - a.overage);

  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: TARGET_SHEET_ID });
  const targetSheet = sheetMeta.data.sheets.find(s => s.properties.title === TARGET_SHEET_NAME);
  const sheetId = targetSheet?.properties.sheetId;
  if (!sheetId) {
    console.error(`❌ Не найден лист "${TARGET_SHEET_NAME}"`);
    return;
  }

  const existingRes = await sheets.spreadsheets.values.get({
    spreadsheetId: TARGET_SHEET_ID,
    range: `${TARGET_SHEET_NAME}!A2:L`,
  });
  const existingRows = existingRes.data.values || [];
  const existingMap = new Map();
  existingRows.forEach(row => {
    const id = row[1];
    const months = parseInt(row[11] || '0');
    if (id) existingMap.set(id, months);
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: TARGET_SHEET_ID,
    requestBody: {
      requests: [{
        updateCells: {
          range: {
            sheetId: sheetId,
            startRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 12
          },
          fields: 'userEnteredValue,userEnteredFormat'
        }
      }]
    }
  });
  console.log('🧼 Значения и формат A:L очищены');

  const output = [
    ['Ответственный', 'company id', 'Название', 'email', 'Телефон', 'Кол-во оплаченных лицензий', 'Кол-во активных сотрудников', 'Превышение', 'Способ оплаты', 'Дата платежа', 'Стоимость лицензии', 'Недель не платят'],
    ...final.map(c => {
      const previous = existingMap.get(c.company_id);
      const months = previous != null ? previous + 2 : '';
      return [
        c.responsible, c.company_id, c.name, c.email, c.phone,
        c.paid_licenses, c.active_employees, c.overage,
        c.payment_method, c.payment_date, c.license_price,
        months
      ];
    })
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: TARGET_SHEET_ID,
    range: `${TARGET_SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: output }
  });
  console.log(`✅ Записано ${final.length} строк в лист "Должники"`);

  // 📐 Выравнивание по центру для B, E–L
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: TARGET_SHEET_ID,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: sheetId,
              startRowIndex: 1,
              startColumnIndex: 1, // B
              endColumnIndex: 2,
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: 'CENTER',
              },
            },
            fields: 'userEnteredFormat.horizontalAlignment',
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: sheetId,
              startRowIndex: 1,
              startColumnIndex: 4, // E to L
              endColumnIndex: 12,
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: 'CENTER',
              },
            },
            fields: 'userEnteredFormat.horizontalAlignment',
          },
        },
      ],
    },
  });
  console.log('📐 Применено выравнивание по центру для B, E–L');

  // 🎨 Подсветка строк
  const today = new Date();
  const monthAhead = new Date(today.getTime() + 30 * 86400000);

  const formatRequests = final.map((row, i) => {
    const rowIndex = i + 2;
    const date = parseDate(row.payment_date);
    if (date && !isNaN(date) && date < monthAhead) {
      return {
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: rowIndex - 1,
            endRowIndex: rowIndex,
            startColumnIndex: 0,
            endColumnIndex: 12
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: getLightYellow(),
            },
          },
          fields: 'userEnteredFormat.backgroundColor',
        }
      };
    }
    return null;
  }).filter(Boolean);

  if (formatRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: TARGET_SHEET_ID,
      requestBody: { requests: formatRequests },
    });
    console.log(`🎨 Подсвечено ${formatRequests.length} строк`);
  }
}
