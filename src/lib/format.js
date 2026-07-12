// Rounded whole-dollar amount with a proper minus sign: -1234.5 => "−$1,235"
export const fmtMoney = (n) =>
  (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();
