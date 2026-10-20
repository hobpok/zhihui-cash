import { normalizeInitialTemplate } from './initial-data.js';
import { currentBusinessDate } from './default-scenario.js';

// Embedded public derivative of the historical synthetic original.
// Business fields preserved; original source-location metadata omitted.
// Keep original amounts, security/holding links, quarterly facts and tenors.
// Embedding avoids runtime fetches and JSON-module support requirements.
const ORIGINAL_TEMPLATE = {
  "templateVersion": "initial-template-1",
  "templateId": "SIM-DEFAULT-COMPLEX-01",
  "label": "收益导向零现金单日模拟样例",
  "revision": 1,
  "demoMode": "single-day-principal-v1",
  "provenance": {
    "kind": "synthetic",
    "note": "银行名称仅为演示标签；全部评级、托管资格、季度净资产、金额、持仓、证券代码、期限和交易计划均为合成模拟参数，并非真实行情或已核实银行资料。非银行短融为分散资产束，不代表单一真实发行人。"
  },
  "businessDate": "2026-10-14",
  "portfolio": {
    "portfolioId": "SIM-FUND-500",
    "label": "模拟500亿货币基金",
    "navYuan": 50000000000,
    "accountCashYuan": 0,
    "netSubscriptionYuan": 0,
    "feeYuan": 0,
    "bufferYuan": 0,
    "legacyBankExposureYuan": null
  },
  "banks": [
    {
      "bankId": "SIM-BANK-ZY",
      "label": "中原银行",
      "custodyQualified": false,
      "rating": "AAA",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 100000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-GZ",
      "label": "广州银行",
      "custodyQualified": false,
      "rating": "AA",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 100000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-XM",
      "label": "厦门银行",
      "custodyQualified": false,
      "rating": "AA",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 100000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-ZZ",
      "label": "郑州银行",
      "custodyQualified": true,
      "rating": "BB",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 100000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-WB",
      "label": "微众银行",
      "custodyQualified": true,
      "rating": "BB",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 100000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-ICBC",
      "label": "工商银行",
      "custodyQualified": true,
      "rating": "AAA",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 200000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-CCB",
      "label": "建设银行",
      "custodyQualified": true,
      "rating": "AAA",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 200000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-CDRCB",
      "label": "成都农商银行",
      "custodyQualified": true,
      "rating": "AAA",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 110000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-CMB",
      "label": "招商银行",
      "custodyQualified": true,
      "rating": "AAA",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 200000000000,
      "quarterEnd": "2026-06-30"
    },
    {
      "bankId": "SIM-BANK-CIB",
      "label": "兴业银行",
      "custodyQualified": true,
      "rating": "AAA",
      "ratingAsOf": "2026-10-14",
      "quarterlyNetAssetsYuan": 200000000000,
      "quarterEnd": "2026-06-30"
    }
  ],
  "securities": [
    {
      "securityId": "SIM-GOV-30",
      "label": "模拟一年内政府债",
      "instrumentKind": "government_bond",
      "issuerBankId": null,
      "issuerType": "government",
      "isGovernmentBond": true,
      "remainingTradingDays": 30
    },
    {
      "securityId": "SIM-ZY-DEP-OLD",
      "label": "模拟中原银行存款持仓",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-ZY",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 100
    },
    {
      "securityId": "SIM-ZY-CD-OLD",
      "label": "模拟中原银行旧存单",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-ZY",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 30
    },
    {
      "securityId": "SIM-GZ-DEP-OLD",
      "label": "模拟广州银行存款持仓",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-GZ",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    },
    {
      "securityId": "SIM-GZ-CD-OLD",
      "label": "模拟广州银行旧存单",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-GZ",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 120
    },
    {
      "securityId": "SIM-XM-DEP-OLD",
      "label": "模拟厦门银行存款持仓",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-XM",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    },
    {
      "securityId": "SIM-XM-CD-OLD",
      "label": "模拟厦门银行旧存单",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-XM",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 120
    },
    {
      "securityId": "SIM-ZZ-CD-OLD",
      "label": "模拟郑州银行旧存单",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-ZZ",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 70
    },
    {
      "securityId": "SIM-WB-CD-OLD",
      "label": "模拟微众银行旧存单",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-WB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    },
    {
      "securityId": "SIM-ICBC-DEP-OLD",
      "label": "模拟工商银行存款底仓",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-ICBC",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 100
    },
    {
      "securityId": "SIM-ICBC-CD-OLD",
      "label": "模拟工商银行存单底仓",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-ICBC",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 100
    },
    {
      "securityId": "SIM-CDRCB-DEP-OLD",
      "label": "模拟成都农商银行存款底仓",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-CDRCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 100
    },
    {
      "securityId": "SIM-CDRCB-CD-OLD",
      "label": "模拟成都农商银行存单底仓",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CDRCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 100
    },
    {
      "securityId": "SIM-CMB-DEP-OLD",
      "label": "模拟招商银行存款底仓",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-CMB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 110
    },
    {
      "securityId": "SIM-CMB-CD-OLD",
      "label": "模拟招商银行存单底仓",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CMB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 110
    },
    {
      "securityId": "SIM-CIB-DEP-OLD",
      "label": "模拟兴业银行存款底仓",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-CIB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 110
    },
    {
      "securityId": "SIM-CIB-CD-OLD",
      "label": "模拟兴业银行存单底仓",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CIB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 110
    },
    {
      "securityId": "SIM-NB-BASKET-75A",
      "label": "模拟分散非银行短融资产束一（非单一真实发行人）",
      "instrumentKind": "bond",
      "issuerBankId": null,
      "issuerType": "non_bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 70
    },
    {
      "securityId": "SIM-NB-BASKET-80",
      "label": "模拟分散非银行短融资产束二（非单一真实发行人）",
      "instrumentKind": "bond",
      "issuerBankId": null,
      "issuerType": "non_bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 80
    },
    {
      "securityId": "SIM-NB-BASKET-75B",
      "label": "模拟分散非银行短融资产束三（非单一真实发行人）",
      "instrumentKind": "bond",
      "issuerBankId": null,
      "issuerType": "non_bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 75
    },
    {
      "securityId": "SIM-ZY-DEP-NEW",
      "label": "模拟中原银行新存款",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-ZY",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 180
    },
    {
      "securityId": "SIM-CDRCB-DEP-NEW",
      "label": "模拟成都农商银行新存款",
      "instrumentKind": "deposit",
      "issuerBankId": "SIM-BANK-CDRCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 100
    },
    {
      "securityId": "SIM-ZY-CD-NEW",
      "label": "模拟中原银行新存单",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-ZY",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 120
    },
    {
      "securityId": "SIM-GZ-CD-NEW",
      "label": "模拟广州银行新存单",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-GZ",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 150
    },
    {
      "securityId": "SIM-ICBC-CD-30",
      "label": "模拟工商银行可买存单30天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-ICBC",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 30
    },
    {
      "securityId": "SIM-ICBC-CD-60",
      "label": "模拟工商银行可买存单60天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-ICBC",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 60
    },
    {
      "securityId": "SIM-ICBC-CD-90",
      "label": "模拟工商银行可买存单90天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-ICBC",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    },
    {
      "securityId": "SIM-ICBC-CD-120",
      "label": "模拟工商银行可买存单120天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-ICBC",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 120
    },
    {
      "securityId": "SIM-CCB-CD-30",
      "label": "模拟建设银行可买存单30天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 30
    },
    {
      "securityId": "SIM-CCB-CD-60",
      "label": "模拟建设银行可买存单60天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 60
    },
    {
      "securityId": "SIM-CCB-CD-90",
      "label": "模拟建设银行可买存单90天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    },
    {
      "securityId": "SIM-CCB-CD-120",
      "label": "模拟建设银行可买存单120天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 120
    },
    {
      "securityId": "SIM-CDRCB-CD-30",
      "label": "模拟成都农商银行可买存单30天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CDRCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 30
    },
    {
      "securityId": "SIM-CDRCB-CD-60",
      "label": "模拟成都农商银行可买存单60天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CDRCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 60
    },
    {
      "securityId": "SIM-CDRCB-CD-90",
      "label": "模拟成都农商银行可买存单90天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CDRCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    },
    {
      "securityId": "SIM-CDRCB-CD-120",
      "label": "模拟成都农商银行可买存单120天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CDRCB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 120
    },
    {
      "securityId": "SIM-CMB-CD-30",
      "label": "模拟招商银行可买存单30天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CMB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 30
    },
    {
      "securityId": "SIM-CMB-CD-60",
      "label": "模拟招商银行可买存单60天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CMB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 60
    },
    {
      "securityId": "SIM-CMB-CD-90",
      "label": "模拟招商银行可买存单90天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CMB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    },
    {
      "securityId": "SIM-CMB-CD-120",
      "label": "模拟招商银行可买存单120天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CMB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 120
    },
    {
      "securityId": "SIM-CIB-CD-30",
      "label": "模拟兴业银行可买存单30天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CIB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 30
    },
    {
      "securityId": "SIM-CIB-CD-60",
      "label": "模拟兴业银行可买存单60天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CIB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 60
    },
    {
      "securityId": "SIM-CIB-CD-90",
      "label": "模拟兴业银行可买存单90天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CIB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    },
    {
      "securityId": "SIM-CIB-CD-120",
      "label": "模拟兴业银行可买存单120天",
      "instrumentKind": "cd",
      "issuerBankId": "SIM-BANK-CIB",
      "issuerType": "bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 120
    },
    {
      "securityId": "SIM-NB-BOND-60",
      "label": "模拟非银行短融买入60天",
      "instrumentKind": "bond",
      "issuerBankId": null,
      "issuerType": "non_bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 60
    },
    {
      "securityId": "SIM-NB-BOND-90",
      "label": "模拟非银行短融买入90天",
      "instrumentKind": "bond",
      "issuerBankId": null,
      "issuerType": "non_bank",
      "isGovernmentBond": false,
      "remainingTradingDays": 90
    }
  ],
  "holdings": [
    {
      "holdingId": "H-SIM-GOV-30",
      "securityId": "SIM-GOV-30",
      "amountYuan": 2510000000,
      "sellableYuan": 2510000000
    },
    {
      "holdingId": "H-SIM-ZY-DEP-OLD",
      "securityId": "SIM-ZY-DEP-OLD",
      "amountYuan": 1000000000,
      "sellableYuan": 0
    },
    {
      "holdingId": "H-SIM-ZY-CD-OLD",
      "securityId": "SIM-ZY-CD-OLD",
      "amountYuan": 1450000000,
      "sellableYuan": 1300000000
    },
    {
      "holdingId": "H-SIM-GZ-DEP-OLD",
      "securityId": "SIM-GZ-DEP-OLD",
      "amountYuan": 800000000,
      "sellableYuan": 0
    },
    {
      "holdingId": "H-SIM-GZ-CD-OLD",
      "securityId": "SIM-GZ-CD-OLD",
      "amountYuan": 1600000000,
      "sellableYuan": 1600000000
    },
    {
      "holdingId": "H-SIM-XM-DEP-OLD",
      "securityId": "SIM-XM-DEP-OLD",
      "amountYuan": 500000000,
      "sellableYuan": 0
    },
    {
      "holdingId": "H-SIM-XM-CD-OLD",
      "securityId": "SIM-XM-CD-OLD",
      "amountYuan": 1500000000,
      "sellableYuan": 1500000000
    },
    {
      "holdingId": "H-SIM-ZZ-CD-OLD",
      "securityId": "SIM-ZZ-CD-OLD",
      "amountYuan": 600000000,
      "sellableYuan": 600000000
    },
    {
      "holdingId": "H-SIM-WB-CD-OLD",
      "securityId": "SIM-WB-CD-OLD",
      "amountYuan": 400000000,
      "sellableYuan": 400000000
    },
    {
      "holdingId": "H-SIM-ICBC-DEP-OLD",
      "securityId": "SIM-ICBC-DEP-OLD",
      "amountYuan": 2500000000,
      "sellableYuan": 0
    },
    {
      "holdingId": "H-SIM-ICBC-CD-OLD",
      "securityId": "SIM-ICBC-CD-OLD",
      "amountYuan": 4000000000,
      "sellableYuan": 4000000000
    },
    {
      "holdingId": "H-SIM-CDRCB-DEP-OLD",
      "securityId": "SIM-CDRCB-DEP-OLD",
      "amountYuan": 2000000000,
      "sellableYuan": 0
    },
    {
      "holdingId": "H-SIM-CDRCB-CD-OLD",
      "securityId": "SIM-CDRCB-CD-OLD",
      "amountYuan": 4000000000,
      "sellableYuan": 4000000000
    },
    {
      "holdingId": "H-SIM-CMB-DEP-OLD",
      "securityId": "SIM-CMB-DEP-OLD",
      "amountYuan": 2000000000,
      "sellableYuan": 0
    },
    {
      "holdingId": "H-SIM-CMB-CD-OLD",
      "securityId": "SIM-CMB-CD-OLD",
      "amountYuan": 4000000000,
      "sellableYuan": 4000000000
    },
    {
      "holdingId": "H-SIM-CIB-DEP-OLD",
      "securityId": "SIM-CIB-DEP-OLD",
      "amountYuan": 2000000000,
      "sellableYuan": 0
    },
    {
      "holdingId": "H-SIM-CIB-CD-OLD",
      "securityId": "SIM-CIB-CD-OLD",
      "amountYuan": 4000000000,
      "sellableYuan": 4000000000
    },
    {
      "holdingId": "H-SIM-NB-BASKET-75A",
      "securityId": "SIM-NB-BASKET-75A",
      "amountYuan": 9000000000,
      "sellableYuan": 9000000000
    },
    {
      "holdingId": "H-SIM-NB-BASKET-80",
      "securityId": "SIM-NB-BASKET-80",
      "amountYuan": 5132000000,
      "sellableYuan": 5132000000
    },
    {
      "holdingId": "H-SIM-NB-BASKET-75B",
      "securityId": "SIM-NB-BASKET-75B",
      "amountYuan": 1008000000,
      "sellableYuan": 1008000000
    }
  ],
  "termWeights": {
    "version": "term-weights-1",
    "coverage": "complete",
    "calendar": "day-365-demo-v1",
    "asOfDate": "2026-10-14",
    "assets": [
      {
        "weightId": "TW-SIM-CASH",
        "label": "模拟账户现金",
        "amountYuan": 0,
        "remainingTradingDays": 0,
        "sourceAccountCash": true
      },
      {
        "weightId": "TW-SIM-GOV-30",
        "label": "模拟一年内政府债",
        "amountYuan": 2510000000,
        "remainingTradingDays": 30,
        "sourceHoldingId": "H-SIM-GOV-30"
      },
      {
        "weightId": "TW-SIM-ZY-DEP-OLD",
        "label": "模拟中原银行存款持仓",
        "amountYuan": 1000000000,
        "remainingTradingDays": 100,
        "sourceHoldingId": "H-SIM-ZY-DEP-OLD"
      },
      {
        "weightId": "TW-SIM-ZY-CD-OLD",
        "label": "模拟中原银行旧存单",
        "amountYuan": 1450000000,
        "remainingTradingDays": 30,
        "sourceHoldingId": "H-SIM-ZY-CD-OLD"
      },
      {
        "weightId": "TW-SIM-GZ-DEP-OLD",
        "label": "模拟广州银行存款持仓",
        "amountYuan": 800000000,
        "remainingTradingDays": 90,
        "sourceHoldingId": "H-SIM-GZ-DEP-OLD"
      },
      {
        "weightId": "TW-SIM-GZ-CD-OLD",
        "label": "模拟广州银行旧存单",
        "amountYuan": 1600000000,
        "remainingTradingDays": 120,
        "sourceHoldingId": "H-SIM-GZ-CD-OLD"
      },
      {
        "weightId": "TW-SIM-XM-DEP-OLD",
        "label": "模拟厦门银行存款持仓",
        "amountYuan": 500000000,
        "remainingTradingDays": 90,
        "sourceHoldingId": "H-SIM-XM-DEP-OLD"
      },
      {
        "weightId": "TW-SIM-XM-CD-OLD",
        "label": "模拟厦门银行旧存单",
        "amountYuan": 1500000000,
        "remainingTradingDays": 120,
        "sourceHoldingId": "H-SIM-XM-CD-OLD"
      },
      {
        "weightId": "TW-SIM-ZZ-CD-OLD",
        "label": "模拟郑州银行旧存单",
        "amountYuan": 600000000,
        "remainingTradingDays": 70,
        "sourceHoldingId": "H-SIM-ZZ-CD-OLD"
      },
      {
        "weightId": "TW-SIM-WB-CD-OLD",
        "label": "模拟微众银行旧存单",
        "amountYuan": 400000000,
        "remainingTradingDays": 90,
        "sourceHoldingId": "H-SIM-WB-CD-OLD"
      },
      {
        "weightId": "TW-SIM-ICBC-DEP-OLD",
        "label": "模拟工商银行存款底仓",
        "amountYuan": 2500000000,
        "remainingTradingDays": 100,
        "sourceHoldingId": "H-SIM-ICBC-DEP-OLD"
      },
      {
        "weightId": "TW-SIM-ICBC-CD-OLD",
        "label": "模拟工商银行存单底仓",
        "amountYuan": 4000000000,
        "remainingTradingDays": 100,
        "sourceHoldingId": "H-SIM-ICBC-CD-OLD"
      },
      {
        "weightId": "TW-SIM-CDRCB-DEP-OLD",
        "label": "模拟成都农商银行存款底仓",
        "amountYuan": 2000000000,
        "remainingTradingDays": 100,
        "sourceHoldingId": "H-SIM-CDRCB-DEP-OLD"
      },
      {
        "weightId": "TW-SIM-CDRCB-CD-OLD",
        "label": "模拟成都农商银行存单底仓",
        "amountYuan": 4000000000,
        "remainingTradingDays": 100,
        "sourceHoldingId": "H-SIM-CDRCB-CD-OLD"
      },
      {
        "weightId": "TW-SIM-CMB-DEP-OLD",
        "label": "模拟招商银行存款底仓",
        "amountYuan": 2000000000,
        "remainingTradingDays": 110,
        "sourceHoldingId": "H-SIM-CMB-DEP-OLD"
      },
      {
        "weightId": "TW-SIM-CMB-CD-OLD",
        "label": "模拟招商银行存单底仓",
        "amountYuan": 4000000000,
        "remainingTradingDays": 110,
        "sourceHoldingId": "H-SIM-CMB-CD-OLD"
      },
      {
        "weightId": "TW-SIM-CIB-DEP-OLD",
        "label": "模拟兴业银行存款底仓",
        "amountYuan": 2000000000,
        "remainingTradingDays": 110,
        "sourceHoldingId": "H-SIM-CIB-DEP-OLD"
      },
      {
        "weightId": "TW-SIM-CIB-CD-OLD",
        "label": "模拟兴业银行存单底仓",
        "amountYuan": 4000000000,
        "remainingTradingDays": 110,
        "sourceHoldingId": "H-SIM-CIB-CD-OLD"
      },
      {
        "weightId": "TW-SIM-NB-BASKET-75A",
        "label": "模拟分散非银行短融资产束一（非单一真实发行人）",
        "amountYuan": 9000000000,
        "remainingTradingDays": 70,
        "sourceHoldingId": "H-SIM-NB-BASKET-75A"
      },
      {
        "weightId": "TW-SIM-NB-BASKET-80",
        "label": "模拟分散非银行短融资产束二（非单一真实发行人）",
        "amountYuan": 5132000000,
        "remainingTradingDays": 80,
        "sourceHoldingId": "H-SIM-NB-BASKET-80"
      },
      {
        "weightId": "TW-SIM-NB-BASKET-75B",
        "label": "模拟分散非银行短融资产束三（非单一真实发行人）",
        "amountYuan": 1008000000,
        "remainingTradingDays": 75,
        "sourceHoldingId": "H-SIM-NB-BASKET-75B"
      }
    ],
    "liabilities": [],
    "positiveRepos": []
  },
  "otherFundBankExposure": [
    {
      "bankId": "SIM-BANK-ZY",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-GZ",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-XM",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-ZZ",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-WB",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-ICBC",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-CCB",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-CDRCB",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-CMB",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    },
    {
      "bankId": "SIM-BANK-CIB",
      "depositYuan": 0,
      "cdYuan": 0,
      "bondYuan": 0,
      "otherYuan": 0
    }
  ],
  "financingResources": {
    "INTERBANK": {
      "quotaConfirmedYuan": null,
      "pledgeConfirmedYuan": null
    },
    "SSE": {
      "quotaConfirmedYuan": null,
      "pledgeConfirmedYuan": null
    },
    "SZSE": {
      "quotaConfirmedYuan": null,
      "pledgeConfirmedYuan": null
    }
  },
  "ruleInitials": {
    "depositThreshold": "0.08",
    "observationThreshold": "0.082"
  },
  "maturityCashEvents": [],
  "pendingSettlements": [],
  "draftPlans": [
    {
      "label": "卖出中原银行旧存单13亿",
      "businessType": "cd_sell",
      "direction": "inflow",
      "counterpartyId": null,
      "issuerId": "SIM-BANK-ZY",
      "targetYuan": 1300000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": null,
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": "SIM-ZY-CD-OLD",
      "marketTier": "secondary"
    },
    {
      "label": "存入成都农商银行6亿",
      "businessType": "deposit",
      "direction": "outflow",
      "counterpartyId": null,
      "issuerId": "SIM-BANK-CDRCB",
      "targetYuan": 600000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": null,
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": "SIM-CDRCB-DEP-NEW",
      "marketTier": null
    },
    {
      "label": "买入中原银行新存单7.5亿120天",
      "businessType": "cd_buy",
      "direction": "outflow",
      "counterpartyId": null,
      "issuerId": "SIM-BANK-ZY",
      "targetYuan": 750000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": null,
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": "SIM-ZY-CD-NEW",
      "marketTier": "secondary"
    },
    {
      "label": "买入广州银行新存单1亿150天",
      "businessType": "cd_buy",
      "direction": "outflow",
      "counterpartyId": null,
      "issuerId": "SIM-BANK-GZ",
      "targetYuan": 100000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": null,
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": "SIM-GZ-CD-NEW",
      "marketTier": "secondary"
    },
    {
      "label": "买入成都农商银行新存单1亿60天",
      "businessType": "cd_buy",
      "direction": "outflow",
      "counterpartyId": null,
      "issuerId": "SIM-BANK-CDRCB",
      "targetYuan": 100000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": null,
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": "SIM-CDRCB-CD-60",
      "marketTier": "secondary"
    },
    {
      "label": "买入模拟非银行短融1亿60天",
      "businessType": "bond_buy",
      "direction": "outflow",
      "counterpartyId": null,
      "issuerId": null,
      "targetYuan": 100000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": null,
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": "SIM-NB-BOND-60",
      "marketTier": "secondary"
    },
    {
      "label": "买入模拟非银行短融1亿90天",
      "businessType": "bond_buy",
      "direction": "outflow",
      "counterpartyId": null,
      "issuerId": null,
      "targetYuan": 100000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": null,
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": "SIM-NB-BOND-90",
      "marketTier": "secondary"
    },
    {
      "label": "银行间正回购融资17.6亿1天",
      "businessType": "interbank_repo_financing",
      "direction": "inflow",
      "counterpartyId": null,
      "issuerId": null,
      "targetYuan": 1760000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": {
        "market": "INTERBANK",
        "tenorDays": 1,
        "annualRate": null
      },
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": null,
      "marketTier": null
    },
    {
      "label": "银行间逆回购投出13.1亿7天",
      "businessType": "reverse_repo",
      "direction": "outflow",
      "counterpartyId": null,
      "issuerId": null,
      "targetYuan": 1310000000,
      "termsNote": "模拟计划；金额、代码、期限及行情均非真实交易数据",
      "repoTerms": {
        "market": "INTERBANK",
        "tenorDays": 7,
        "annualRate": null
      },
      "tradeDate": "2026-10-14",
      "settlementDate": "2026-10-14",
      "securityId": null,
      "marketTier": null
    }
  ]
};

export function createOriginalInitialTemplate({ businessDate = currentBusinessDate() } = {}) {
  const template = structuredClone(ORIGINAL_TEMPLATE);
  template.label = '原始样例：零现金／成农商6%';
  template.businessDate = businessDate;
  for (const bank of template.banks) bank.ratingAsOf = businessDate;
  template.termWeights.asOfDate = businessDate;
  for (const event of template.maturityCashEvents) event.dueDate = businessDate;
  for (const trade of [...template.pendingSettlements, ...template.draftPlans]) {
    trade.tradeDate = businessDate;
    trade.settlementDate = businessDate;
  }
  return normalizeInitialTemplate(template);
}
