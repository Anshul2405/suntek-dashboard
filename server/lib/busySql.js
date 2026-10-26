// Shared Busy reads. Busy voucher types on this PC: 2 purchase, 9 sales,
// 14 receipt, 19 payment, 16 journal.
// Liquid chlorine is a token purchase in their workbook and stays out of the
// raw-material total. Chlorinated paraffin is their product and stays in.

export const NOT_FUTURE = `t.[Date] <= CAST(GETDATE() AS DATE)`;

export const THIS_MONTH = `MONTH(t.[Date]) = MONTH(GETDATE()) AND YEAR(t.[Date]) = YEAR(GETDATE()) AND ${NOT_FUTURE}`;

/**
 * Invoice total, or 0 when every item on the invoice is liquid chlorine.
 * Item-line values in Tran2 are not rupee amounts, so the header total is used.
 */
export function purchaseKeptExpr(alias = 't') {
  return `
    CASE WHEN lines.n > 0 AND lines.chlorine = lines.n THEN 0 ELSE ${alias}.VchAmtBaseCur END
  `;
}

export const PURCHASE_LINES = `
  OUTER APPLY (
    SELECT
      SUM(CASE
        WHEN item.Name LIKE '%liquid chlorine%' OR item.Name LIKE '%liquide chlorine%' THEN 1
        ELSE 0
      END) AS chlorine,
      COUNT(item.Code) AS n
    FROM Tran2 t2
    JOIN Master1 item ON item.Code = t2.MasterCode1 AND item.MasterType = 6
    WHERE t2.VchCode = t.VchCode
  ) lines
`;

export function purchaseSum(extraWhere = '') {
  return `
    (SELECT ISNULL(SUM(${purchaseKeptExpr('t')}), 0)
     FROM Tran1 t
     ${PURCHASE_LINES}
     WHERE t.VchType = 2 AND t.Cancelled = 0
       AND ${NOT_FUTURE}
       ${extraWhere})
  `;
}

/** Party name marks the Kolkata desk or the SHD desk. Kolkata wins if both appear. */
export const SITE_CASE = `
  CASE
    WHEN m.Name LIKE '%kolkata%' OR m.Name LIKE '%calcutta%' THEN 'kolkata'
    WHEN m.Name LIKE '%shd%' THEN 'shd'
    ELSE NULL
  END
`;
