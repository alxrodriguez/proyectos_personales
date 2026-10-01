const fs = require('fs');
const path = require('path');

const CALC_REPO = process.env.CALC_REPO || '/tmp/calcmcp';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/tmp/calculator-costs';
const { fetchCostFromDOM } = require(path.join(CALC_REPO, 'lib/dom-cost'));

const calculators = {
  CU01: 'https://calculator.aws/#/estimate?id=22a95cbb687116f489bac3c1519983f95c7bbfbc',
  CU04: 'https://calculator.aws/#/estimate?id=84512e3f81d71ed4788d473c0499742ce32105fc',
  CU05: 'https://calculator.aws/#/estimate?id=282ea8e98243ddabe6836f8d28bcef83725a1a85',
};

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const results = {};
  for (const [code, url] of Object.entries(calculators)) {
    console.log(`Reading ${code}: ${url}`);
    const cost = await fetchCostFromDOM(url);
    results[code] = {
      url,
      monthly_cost_usd: cost.monthlyCost,
      annual_cost_usd: cost.monthlyCost == null ? null : Number((cost.monthlyCost * 12).toFixed(2)),
      twenty_four_month_cost_usd: cost.monthlyCost == null ? null : Number((cost.monthlyCost * 24).toFixed(2)),
      rows_total_usd: cost.rowsTotal,
      rows: cost.rows,
    };
    console.log(`${code}: monthly USD ${cost.monthlyCost}`);
    console.log(JSON.stringify(cost.rows, null, 2));
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, 'costs.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
