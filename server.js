const express = require("express");
const responseContent = require("./response-content.json");

const app = express();
app.use(express.json());
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getBaseUrl(req) {
  const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
  const forwardedHost = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
  const proto = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host");
  return `${proto}://${host}`;
}

const FORWARD_URL_ADVANCE = "Go to Advanced mode: /fpl/calculate?mode=advance";
const FORWARD_URL_BASIC = "Go to Basic mode: /fpl/calculate?mode=basic";
const FORWARD_URL_HELP = "Go to help: /fpl/calculate/help";

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

function getEligibleBenefitsBasic(fplPercentage, taxFiling) {
  const benefits = [];
  const meetsAptcFplThreshold = fplPercentage > 200;
  const meetsCsrFplThreshold = fplPercentage >= 100 && fplPercentage <= 250;
  const isAdultOregonPublicCoverageEligible = fplPercentage <= 200;

  if (fplPercentage <= 138) {
    benefits.push("Medicaid (OHP Plus)");
  } else if (fplPercentage <= 200) {
    benefits.push("BHP (OHP Bridge)");
  }

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

function getEligibleBenefitsAdvanced(fplPercentage, taxFiling, isAiAn) {
  const benefits = [];
  const ohpBridgeUpperFpl = isAiAn ? 205 : 200;
  const meetsAptcFplThreshold = fplPercentage > ohpBridgeUpperFpl;
  const meetsCsrFplThreshold = fplPercentage >= 100 && fplPercentage <= 250;
  const isAdultOregonPublicCoverageEligible = fplPercentage <= ohpBridgeUpperFpl;

  // Oregon adult program mapping:
  // OHP Plus (Medicaid) up to 138% FPL, OHP Bridge (BHP) above 138% to 200%.
  if (fplPercentage <= 138) {
    benefits.push("Medicaid (OHP Plus)");
  } else if (fplPercentage <= ohpBridgeUpperFpl) {
    if (isAiAn && fplPercentage > 200) {
      benefits.push("BHP (OHP Bridge - AI/AN Basic Medicaid)");
    } else {
      benefits.push("BHP (OHP Bridge)");
    }
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

    if (isAiAn && meetsAptcFplThreshold) {
      if (fplPercentage <= 300) {
        benefits.push("AI/AN Zero Cost Sharing (Marketplace, 100-300%)");
      } else {
        benefits.push("AI/AN Limited Cost Sharing (Marketplace, >300%)");
      }
    } else if (meetsCsrFplThreshold) {
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
  const {
    household_size: householdSize,
    household_income: householdIncome,
    tax_filing: taxFiling,
    is_ai_an: isAiAn
  } = body || {};

  if (!Number.isInteger(householdSize) || householdSize < 1 || householdSize > 20) {
    return "household_size must be an integer between 1 and 20";
  }

  if (typeof householdIncome !== "number" || Number.isNaN(householdIncome) || householdIncome < 0) {
    return "household_income must be a non-negative number";
  }

  if (taxFiling !== "Y" && taxFiling !== "N") {
    return "tax_filing must be 'Y' or 'N'";
  }

  if (typeof isAiAn !== "undefined" && typeof isAiAn !== "boolean") {
    return "is_ai_an must be a boolean (true or false)";
  }

  return null;
}

function normalizeAdvancedInputs(body) {
  return {
    year: body?.year,
    householdSize: body?.householdSize ?? body?.household_size,
    householdIncome: body?.household_income,
    isPregnant: body?.isPregnant ?? body?.is_pregnant,
    isChild: body?.isChild ?? body?.is_child,
    taxFilingStatus: body?.taxFilingStatus ?? body?.tax_filing,
    hasAffordableEmployerCoverage: body?.hasAffordableEmployerCoverage ?? body?.has_affordable_employer_coverage,
    citizenshipImmigrationEligible: body?.citizenshipImmigrationEligible ?? body?.citizenship_immigration_eligible,
    enrolledInMedicare: body?.enrolledInMedicare ?? body?.enrolled_in_medicare,
    isAiAn: body?.isAiAn ?? body?.is_ai_an ?? false,
    marketplacePlanMetalLevel: body?.marketplacePlanMetalLevel ?? body?.marketplace_plan_metal_level ?? "Silver"
  };
}

function validateAdvancedPayload(body) {
  const input = normalizeAdvancedInputs(body);

  if (input.year !== "ALL" && input.year !== 2025 && input.year !== 2026) {
    return "year must be 2025, 2026, or ALL";
  }

  if (!Number.isInteger(input.householdSize) || input.householdSize < 1 || input.householdSize > 20) {
    return "householdSize must be an integer between 1 and 20";
  }

  if (typeof input.householdIncome !== "number" || Number.isNaN(input.householdIncome) || input.householdIncome < 0) {
    return "household_income must be a non-negative number";
  }

  if (typeof input.isPregnant !== "boolean") {
    return "isPregnant must be boolean";
  }
  if (typeof input.isChild !== "boolean") {
    return "isChild must be boolean";
  }
  if (input.taxFilingStatus !== "Y" && input.taxFilingStatus !== "N") {
    return "taxFilingStatus must be 'Y' or 'N'";
  }
  if (typeof input.hasAffordableEmployerCoverage !== "boolean") {
    return "hasAffordableEmployerCoverage must be boolean";
  }
  if (typeof input.citizenshipImmigrationEligible !== "boolean") {
    return "citizenshipImmigrationEligible must be boolean";
  }
  if (typeof input.enrolledInMedicare !== "boolean") {
    return "enrolledInMedicare must be boolean";
  }
  if (typeof input.isAiAn !== "boolean") {
    return "isAiAn (or is_ai_an) must be boolean";
  }

  return null;
}

function calculateResults(householdSize, householdIncome, taxFiling, mode, isAiAn = false) {
  const normalizedIncome = round2(householdIncome);
  const results = {};

  [2025, 2026].forEach((year) => {
    const baseValue = getFplBaseValue(year, householdSize);
    const fplPercentage = round2((normalizedIncome / baseValue) * 100);

    const benefits = mode === "ADVANCE"
      ? getEligibleBenefitsAdvanced(fplPercentage, taxFiling, isAiAn)
      : getEligibleBenefitsBasic(fplPercentage, taxFiling);

    results[String(year)] = {
      year,
      fpl_base_value: round2(baseValue),
      fpl_percentage: fplPercentage,
      consumer_eligible_benefit: benefits
    };
  });

  return {
    mode,
    results, 
    modes: [FORWARD_URL_ADVANCE, FORWARD_URL_HELP]
  };
}

function buildAdvancePolicySpec() {
  return cloneJson(responseContent.advancePolicySpec);
}

function evaluateAdvancedPrograms({
  fplPercentage,
  taxFilingStatus,
  isAiAn,
  isPregnant,
  isChild,
  hasAffordableEmployerCoverage,
  citizenshipImmigrationEligible,
  enrolledInMedicare,
  marketplacePlanMetalLevel
}) {
  const eligiblePrograms = [];
  const ineligibleReasons = [];
  const messages = [];
  const bridgeUpper = isAiAn ? 205 : 200;

  if (!isChild && !isPregnant && citizenshipImmigrationEligible && fplPercentage <= 138) {
    eligiblePrograms.push("Medicaid_OHPPlus_Adult");
  } else if (
    !isChild &&
    !isPregnant &&
    citizenshipImmigrationEligible &&
    fplPercentage > 138 &&
    fplPercentage <= bridgeUpper &&
    !hasAffordableEmployerCoverage &&
    !enrolledInMedicare
  ) {
    eligiblePrograms.push("BHP_OHPBridge_Adult");
  }

  if (isChild && citizenshipImmigrationEligible && fplPercentage < 163) {
    eligiblePrograms.push("Medicaid_OHPPlus_Child");
  } else if (isChild && citizenshipImmigrationEligible && fplPercentage <= 300) {
    eligiblePrograms.push("CHIP_Child");
  }

  if (
    fplPercentage > bridgeUpper &&
    taxFilingStatus === "Y" &&
    !hasAffordableEmployerCoverage &&
    !enrolledInMedicare &&
    citizenshipImmigrationEligible
  ) {
    eligiblePrograms.push("Marketplace_APTC");
  }

  if (
    fplPercentage >= 100 &&
    fplPercentage <= 250 &&
    taxFilingStatus === "Y" &&
    marketplacePlanMetalLevel === "Silver"
  ) {
    eligiblePrograms.push("Marketplace_CSR");
  } else if (taxFilingStatus === "Y" && !(fplPercentage >= 100 && fplPercentage <= 250)) {
    ineligibleReasons.push("Marketplace_CSR FPL condition not met");
  } else if (taxFilingStatus === "Y" && marketplacePlanMetalLevel !== "Silver") {
    ineligibleReasons.push("Marketplace_CSR requires Silver plan");
  }

  if (taxFilingStatus === "N" && fplPercentage > bridgeUpper) {
    messages.push("APTC_CSR_NOT_AVAILABLE_NON_TAX_FILER");
  }

  return { eligiblePrograms, ineligibleReasons, messages };
}

/** Maps `eligiblePrograms` IDs to consumer-facing labels (strict path; 1:1 with engine output). */
const ELIGIBLE_PROGRAM_TO_CONSUMER_LABEL = {
  Medicaid_OHPPlus_Adult: "Medicaid (OHP Plus)",
  BHP_OHPBridge_Adult: "BHP (OHP Bridge)",
  Medicaid_OHPPlus_Child: "Medicaid (OHP Plus) — child",
  CHIP_Child: "CHIP",
  Marketplace_APTC: "APTC",
  Marketplace_CSR: "CSR (Silver plan only)"
};

function strictConsumerEligibleBenefitFromPrograms(eligiblePrograms) {
  return eligiblePrograms.map((programId) => {
    const label = ELIGIBLE_PROGRAM_TO_CONSUMER_LABEL[programId];
    return label !== undefined ? label : programId;
  });
}

function calculateAdvancedSpecResponse(reqBody) {
  const input = normalizeAdvancedInputs(reqBody);
  const {
    year,
    householdSize,
    householdIncome,
    taxFilingStatus,
    isAiAn,
    isPregnant,
    isChild,
    hasAffordableEmployerCoverage,
    citizenshipImmigrationEligible,
    enrolledInMedicare,
    marketplacePlanMetalLevel
  } = input;

  const normalizedIncome = round2(householdIncome);
  const yearsToEvaluate = year === "ALL" ? [2025, 2026] : [year];
  const response = {
    evaluationByYear: {}, 
    modes: [FORWARD_URL_BASIC, FORWARD_URL_HELP]
  };

  yearsToEvaluate.forEach((evalYear) => {
    const baseValue = getFplBaseValue(evalYear, householdSize);
    const fplPercentage = round2((normalizedIncome / baseValue) * 100);
    const evaluated = evaluateAdvancedPrograms({
      fplPercentage,
      taxFilingStatus,
      isAiAn,
      isPregnant,
      isChild,
      hasAffordableEmployerCoverage,
      citizenshipImmigrationEligible,
      enrolledInMedicare,
      marketplacePlanMetalLevel
    });

    response.evaluationByYear[String(evalYear)] = {
      fplPercent: fplPercentage,
      eligiblePrograms: evaluated.eligiblePrograms,
      ineligibleReasons: evaluated.ineligibleReasons,
      messages: evaluated.messages,
      consumer_eligible_benefit: getEligibleBenefitsAdvanced(fplPercentage, taxFilingStatus, isAiAn)
        };
  });

  return response;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/fpl/calculate/help", (req, res) => {
  const baseUrl = getBaseUrl(req);

  return res.json({
    ...cloneJson(responseContent.helpResponseTemplate),
    base_url: baseUrl
  });
});

app.post("/fpl/calculate/basic", (req, res) => {
  const validationError = validatePayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const {
    household_size: householdSize,
    household_income: householdIncome,
    tax_filing: taxFiling
  } = req.body;

  return res.json(calculateResults(householdSize, householdIncome, taxFiling, "BASIC"));
});

app.post("/fpl/calculate/advance", (req, res) => {
  const validationError = validateAdvancedPayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  return res.json(calculateAdvancedSpecResponse(req.body));
});

app.post("/fpl/calculate", (req, res) => {
  const mode = String(req.query.mode || "BASIC").toUpperCase();
  if (mode !== "BASIC" && mode !== "ADVANCE") {
    return res.status(400).json({
      error: "Invalid mode. Use mode=BASIC or mode=ADVANCE. You can also call POST /fpl/calculate/basic or POST /fpl/calculate/advance directly."
    });
  }

  const validationError = validatePayload(req.body);
  if (mode === "ADVANCE") {
    const advanceValidationError = validateAdvancedPayload(req.body);
    if (advanceValidationError) {
      return res.status(400).json({ error: advanceValidationError });
    }
    return res.json(calculateAdvancedSpecResponse(req.body));
  }

  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const {
    household_size: householdSize,
    household_income: householdIncome,
    tax_filing: taxFiling
  } = req.body;

  return res.json(calculateResults(householdSize, householdIncome, taxFiling, mode));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`FPL Calculator API listening on port ${PORT}`);
});
