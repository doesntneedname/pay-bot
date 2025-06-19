import cron from 'node-cron';
import { main } from './index.js';
import { notifyDebtors } from './linear.js';
import dotenv from 'dotenv';
dotenv.config();

// ISO-неделя с учётом МСК (UTC+3)
function getISOWeekMSK() {
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000); // МСК
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.floor(((date - yearStart) / 86400000 + 1) / 7);
}

// 00:01 МСК = 21:01 UTC (воскресенье)
cron.schedule('1 21 * * 0', async () => {
  const week = getISOWeekMSK();
  console.log(`🧮 ISO неделя по МСК: ${week} — ${week % 2 === 0 ? 'чётная' : 'нечётная'}`);
  if (week % 2 === 0) {
    console.log('📆 main() — каждый второй понедельник, 00:01 МСК');
    await main();
  }
});

// 09:30 МСК = 06:30 UTC (понедельник)
cron.schedule('30 6 * * 1', async () => {
  const week = getISOWeekMSK();
  console.log(`🧮 ISO неделя по МСК: ${week} — ${week % 2 === 0 ? 'чётная' : 'нечётная'}`);
  if (week % 2 === 0) {
    console.log('📆 notifyDebtors() — каждый второй понедельник, 09:30 МСК');
    await notifyDebtors();
  }
});
