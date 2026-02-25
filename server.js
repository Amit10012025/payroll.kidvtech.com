/**
 * KIDV Tech — SmartOffice Bridge v6
 *
 * ✅ FINAL FIX:
 *    AttendanceLogs.EmployeeId (1,2,3...)
 *    JOIN Employees ON EmployeeId
 *    → EmployeeCode = VS210, C283, Y401... = Device Code
 *
 *    Employees page ma deviceCode = "VS012", "VS210", "C283"... set karo
 *    (SmartOffice EmployeeCode same j)
 *
 * Also handles: Date filter for 2024 data (DB ma 2024 tak data che)
 */
const express = require('express');
const mssql   = require('mssql');
const cors    = require('cors');
const app     = express();
app.use(cors());
app.use(express.json());

const DB_CONFIG = {
  server:   'ERP-PC',
  port:     1433,
  database: 'SmartOfficeold',
  user:     'sa',
  password: 'smartoffice',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    connectTimeout: 15000,
    instanceName: 'SQLEXPRESS'
  }
};

let pool = null;
async function getPool() {
  if (!pool) pool = await mssql.connect(DB_CONFIG);
  return pool;
}

app.get('/api/test', async (req, res) => {
  try { pool = null; await getPool(); res.json({ success: true }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/tables', async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
    );
    res.json({ success: true, tables: r.recordset.map(x => x.TABLE_NAME) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/columns/:table', async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().query(
      `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${req.params.table}' ORDER BY ORDINAL_POSITION`
    );
    res.json({ success: true, columns: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/preview/:table', async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().query(`SELECT TOP 20 * FROM [${req.params.table}]`);
    res.json({ success: true, rows: r.recordset, columns: Object.keys(r.recordset[0] || {}), count: r.recordset.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Employee list with EmployeeCode ──────────────────
app.get('/api/employees', async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().query(
      `SELECT TOP 300 
         al.EmployeeId,
         e.EmployeeCode,
         e.EmployeeName,
         e.EmployeeCodeInDevice
       FROM Employees e
       ORDER BY e.EmployeeId`
    );
    res.json({ success: true, employees: r.recordset });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Attendance fetch — v6 JOIN fix ───────────────────
// ✅ JOIN AttendanceLogs + Employees to get EmployeeCode
// ✅ EmployeeCode (VS210, C283...) = device code for matching
app.post('/api/attendance', async (req, res) => {
  try {
    const p = await getPool();
    const { fromDate, toDate, table } = req.body;
    const tbl = table || 'AttendanceLogs';

    const dateFilter = (fromDate && toDate)
      ? `WHERE CAST(al.AttendanceDate AS DATE) BETWEEN '${fromDate}' AND '${toDate}'`
      : '';

    // ✅ JOIN to get EmployeeCode (VS210, C283...)
    // Also fallback: EmployeeCodeInDevice if EmployeeCode null
    const query = `
      SELECT
        ISNULL(e.EmployeeCodeInDevice, ISNULL(e.EmployeeCode, CAST(al.EmployeeId AS VARCHAR(20)))) AS EmpCode,
        e.EmployeeName,
        e.EmployeeCode,
        CAST(al.AttendanceDate AS DATE)  AS PunchDate,
        ISNULL(al.InTime,  '')           AS InTime,
        ISNULL(al.OutTime, '')           AS OutTime,
        ISNULL(al.Duration, 0)           AS Duration,
        ISNULL(al.LateBy, 0)             AS LateBy
      FROM [${tbl}] al
      LEFT JOIN Employees e ON al.EmployeeId = e.EmployeeId
      ${dateFilter}
      ORDER BY PunchDate, al.EmployeeId
    `;

    const result = await p.request().query(query);

    const attendance = result.recordset.map(row => {
      const code    = String(row.EmpCode || '').trim().toUpperCase();
      const date    = row.PunchDate
        ? new Date(row.PunchDate).toISOString().substring(0, 10)
        : null;

      const inT      = (row.InTime  || '').trim();
      const outT     = (row.OutTime || '').trim();
      const duration = parseInt(row.Duration || 0);

      let status = 'A';
      if (inT && inT !== '00:00') {
        status = (duration > 0 && duration < 240) ? 'H' : 'P';
      }

      return {
        devCode:      code,
        employeeName: row.EmployeeName || '',
        employeeCode: row.EmployeeCode || '',
        date,
        inTime:   inT,
        outTime:  outT,
        duration,
        status,
        rawStatus: inT ? `IN:${inT} OUT:${outT}` : 'No Punch'
      };
    }).filter(r => r.devCode && r.date);

    res.json({
      success:  true,
      count:    attendance.length,
      attendance,
      rawRows:  result.recordset.length
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error:   err.message,
      hint:    err.message.includes('EmployeeId')
        ? 'AttendanceLogs ma EmployeeId column ambiguous — table alias check karo'
        : 'Show Columns click karo → actual column names check karo'
    });
  }
});

// ── Diagnose ─────────────────────────────────────────
app.get('/api/diagnose/:table', async (req, res) => {
  try {
    const p   = await getPool();
    const tbl = req.params.table;

    const cntR  = await p.request().query(`SELECT COUNT(*) AS Total FROM [${tbl}]`);
    const total = cntR.recordset[0].Total;

    const dateR = await p.request().query(
      `SELECT MIN(AttendanceDate) AS MinDate, MAX(AttendanceDate) AS MaxDate FROM [${tbl}]`
    );

    // ✅ Sample EmployeeCodes via JOIN
    let sampleIds = [];
    try {
      const sampR = await p.request().query(`
        SELECT DISTINCT TOP 5 
          ISNULL(e.EmployeeCodeInDevice, ISNULL(e.EmployeeCode, CAST(al.EmployeeId AS VARCHAR))) AS DevCode
        FROM [${tbl}] al
        LEFT JOIN Employees e ON al.EmployeeId = e.EmployeeId
      `);
      sampleIds = sampR.recordset.map(r => r.DevCode);
    } catch {
      const sampR2 = await p.request().query(
        `SELECT DISTINCT TOP 5 CAST(EmployeeId AS VARCHAR(20)) AS DevCode FROM [${tbl}]`
      );
      sampleIds = sampR2.recordset.map(r => r.DevCode);
    }

    res.json({
      success:    true,
      table:      tbl,
      totalRows:  total,
      dateRange: {
        min: dateR.recordset[0].MinDate,
        max: dateR.recordset[0].MaxDate
      },
      sampleUserIds: sampleIds
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => res.json({
  status:  'KIDV Tech SmartOffice Bridge v6',
  fix:     'JOIN AttendanceLogs + Employees → EmployeeCode = DevCode',
  note:    'Employees page deviceCode = VS012, VS210, C283... (EmployeeCode from SmartOffice)',
  helper:  'GET /api/employees → full mapping list',
  warning: 'DB ma data 2024 tak che — date filter 2020-2024 use karo'
}));

const PORT = 3377;
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  KIDV Tech SmartOffice Bridge v6  |  Port 3377      ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  ✅ JOIN fix: AttendanceLogs + Employees table       ║');
  console.log('║  ✅ DevCode = EmployeeCode (VS210, C283, Y401...)    ║');
  console.log('║                                                       ║');
  console.log('║  ⚠️  DB ma data 2024 tak che (Oct 2024 latest)       ║');
  console.log('║     Date filter 2024-01-01 to 2024-10-29 use karo   ║');
  console.log('║     ya "Fetch All" button use karo                   ║');
  console.log('║                                                       ║');
  console.log('║  Browser ma open karo:                               ║');
  console.log('║  http://localhost:3377/api/employees                  ║');
  console.log('║  → EmployeeId + EmployeeCode + EmployeeName          ║');
  console.log('║  → Employees page ma same deviceCode set karo        ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
});
