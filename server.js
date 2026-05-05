const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Oregon uses the 48 contiguous states/DC poverty guidelines.
// Mapped for household sizes 1..20 for each year.
const FPL_BASE_VALUES = {
  2025: {
    1: 15650,
    2: 21150,
    3: 26650,
    4: 32150,
    5: 37650,
    6: 43150,
    7: 48650,
    8: 54150,
    9: 59650,
    10: 65150,
    11: 70650,
    12: 76150,
    13: 81650,
    14: 87150,
    15: 92650,
    16: 98150,
    17: 103650,
    18: 109150,
    19: 114650,
    20: 120150
  },
  2026: {
    1: 15960,
    2: 21640,
    3: 27320,
    4: 33000,
    5: 38680,
    6: 44360,
    7: 50040,
    8: 55720,
    9: 61400,
    10: 67080,
    11: 72760,
    12: 78440,
    13: 84120,
    14: 89800,
    15: 95480,
    16: 101160,
    17: 106840,
    18: 112520,
    19: 118200,
    20: 123880
  }
};

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getFplBaseValue(year, householdSize) {
  const yearConfig = FPL_BASE_VALUES[year];
  if (!yearConfig) {
    throw new Error(`Unsupported year: ${year}`);
  }

  const mappedValue = yearConfig[householdSize];
  if (!mappedValue) {
    throw new Error(`Unsupported household size for year ${year}: ${householdSize}`);
  }

  return mappedValue;
}

function getEligibleBenefits(fplPercentage, taxFiling) {
  const benefits = [];
  const meetsAptcFplThreshold = fplPercentage > 200;
  const meetsCsrFplThreshold = fplPercentage >= 100 && fplPercentage <= 250;
  const isAdultOregonPublicCoverageEligible = fplPercentage <= 200;

  // Oregon adult program mapping:
  // OHP Plus (Medicaid) up to 138% FPL, OHP Bridge (BHP) above 138% to 200%.
  if (fplPercentage <= 138) {
    benefits.push("Medicaid (OHP Plus)");
  } else if (fplPercentage <= 200) {
    benefits.push("BHP (OHP Bridge)");
  }

  // Oregon child mapping is conditional because this API does not collect child age flags.
  if (fplPercentage < 163) {
    benefits.push("Child Medicaid/OHP (if child in household)");
  } else if (fplPercentage <= 300) {
    benefits.push("CHIP (if child in household)");
  }

  if (taxFiling === "Y") {
    if (meetsAptcFplThreshold) {
      benefits.push("APTC");
    }
    if (meetsCsrFplThreshold) {
      benefits.push("CSR (Silver plan only)");
    }
  } else if (!isAdultOregonPublicCoverageEligible && (meetsAptcFplThreshold || meetsCsrFplThreshold)) {
    benefits.push("APTC/CSR not available (non-tax filer)");
  }

  if (!benefits.length) {
    benefits.push("No standard benefit identified");
  }

  return benefits;
}

function validatePayload(body) {
  const { household_size: householdSize, household_income: householdIncome, tax_filing: taxFiling } = body || {};

  if (!Number.isInteger(householdSize) || householdSize < 1 || householdSize > 20) {
    return "household_size must be an integer between 1 and 20";
  }

  if (typeof householdIncome !== "number" || Number.isNaN(householdIncome) || householdIncome < 0) {
    return "household_income must be a non-negative number";
  }

  if (taxFiling !== "Y" && taxFiling !== "N") {
    return "tax_filing must be 'Y' or 'N'";
  }

  return null;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/fpl/calculate", (req, res) => {
  const validationError = validatePayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { household_size: householdSize, household_income: householdIncome, tax_filing: taxFiling } = req.body;
  const normalizedIncome = round2(householdIncome);
  const results = {};

  [2025, 2026].forEach((year) => {
    const baseValue = getFplBaseValue(year, householdSize);
    const fplPercentage = round2((normalizedIncome / baseValue) * 100);
    const benefits = getEligibleBenefits(fplPercentage, taxFiling);

    results[String(year)] = {
      year,
      fpl_base_value: round2(baseValue),
      fpl_percentage: fplPercentage,
      consumer_eligible_benefit: benefits
    };
  });

  return res.json({
    results
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`FPL Calculator API listening on port ${PORT}`);
});
