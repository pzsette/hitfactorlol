import memoize from "memoize";
import {
  basicInfoForClassifier,
  classifiers,
} from "../../../dataUtil/classifiersData.js";

import {
  extendedInfoForClassifier,
  runsForDivisionClassifier,
  chartData,
} from "../../../classifiers.api.js";

import { multisort } from "../../../../../shared/utils/sort.js";
import { PAGE_SIZE } from "../../../../../shared/constants/pagination.js";
import { HF } from "../../../dataUtil/numbers.js";
import { getExtendedCalibrationShootersPercentileTable } from "../../../dataUtil/shooters.js";
import { mapDivisionsAsync } from "../../../dataUtil/divisions.js";
import { getShooterToRuns } from "../../../dataUtil/classifiers.js";

const classifiersForDivision = memoize(
  async (division) => {
    return await Promise.all(
      classifiers.map(async (c) => ({
        ...basicInfoForClassifier(c),
        ...(await extendedInfoForClassifier(c, division)),
      }))
    );
  },
  { cacheKey: ([division]) => division }
);

/**
 * Calculated recommended HHF by matching lower percent of the score to percentile of shooters
 * who should be able to get that score.
 *
 * Used with 1Percentile for GM (95%) and 5Percentile for M(85%)
 * @param runs classifier scores, sorted by HF or curPercent. MUST BE SORTED for percentile math.
 * @param percentile what percentile to search for 0 to 100
 * @param percent what percent score to assign to it 0 to 100
 */
const recommendedHHFByPercentileAndPercent = (
  runs,
  targetPercentile,
  percent
) => {
  const closestPercentileRun = runs.sort(
    (a, b) =>
      Math.abs(a.percentile - targetPercentile) -
      Math.abs(b.percentile - targetPercentile)
  )[0];
  return HF(
    (closestPercentileRun.hf * closestPercentileRun.percentile) /
      targetPercentile /
      (percent / 100.0)
  );
};

const classifiersRoutes = async (fastify, opts) => {
  fastify.get("/", (req, res) => classifiers.map(basicInfoForClassifier));

  fastify.get(
    "/:division",
    { compress: false },
    async (req) => await classifiersForDivision(req.params.division)
  );
  fastify.addHook("onListen", async () => {
    console.log("hydrating classifiers");
    await mapDivisionsAsync(async (div) => await classifiersForDivision(div));
    await getShooterToRuns();
    console.log("done hydrating classifiers ");
  });

  fastify.get("/download/:division", { compress: false }, async (req, res) => {
    const { division } = req.params;
    res.header(
      "Content-Disposition",
      `attachment; filename=classifiers.${division}.json`
    );
    return await classifiersForDivision(division);
  });

  fastify.get("/:division/:number", async (req, res) => {
    const { division, number } = req.params;
    const {
      sort,
      order,
      page: pageString,
      legacy,
      hhf: filterHHFString,
      club: filterClubString,
      filter: filterString,
    } = req.query;
    const includeNoHF = Number(legacy) === 1;
    const page = Number(pageString) || 1;
    const filterHHF = parseFloat(filterHHFString);
    const c = classifiers.find((cur) => cur.classifier === number);

    if (!c) {
      res.statusCode = 404;
      return { info: null, runs: [] };
    }

    const basic = basicInfoForClassifier(c);
    const extended = await extendedInfoForClassifier(c, division);
    const { hhf, hhfs } = extended;

    let runsUnsorted = await runsForDivisionClassifier({
      number,
      division,
      hhf,
      includeNoHF,
      hhfs,
    });
    if (filterHHF) {
      runsUnsorted = runsUnsorted.filter(
        (run) => Math.abs(filterHHF - run.historicalHHF) <= 0.00015
      );
    }
    if (filterString) {
      runsUnsorted = runsUnsorted.filter((run) =>
        [run.clubid, run.club_name, run.memberNumber, run.name]
          .join("###")
          .toLowerCase()
          .includes(filterString.toLowerCase())
      );
    }
    if (filterClubString) {
      runsUnsorted = runsUnsorted
        .filter((run) => run.clubid === filterClubString)
        .slice(0, 10);
    }
    const runs = multisort(
      runsUnsorted,
      sort?.split?.(","),
      order?.split?.(",")
    ).map((run, index) => ({ ...run, index }));

    const extendedCalibrationTable =
      await getExtendedCalibrationShootersPercentileTable();

    return {
      info: {
        ...basic,
        ...extended,
        recommendedHHF1: recommendedHHFByPercentileAndPercent(
          runsUnsorted,
          extendedCalibrationTable[division].pGM,
          95
        ),
        recommendedHHF5: recommendedHHFByPercentileAndPercent(
          runsUnsorted,
          extendedCalibrationTable[division].pM,
          85
        ),
        recommendedHHF15: recommendedHHFByPercentileAndPercent(
          runsUnsorted,
          extendedCalibrationTable[division].pA,
          75
        ),
      },
      runs: runs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      runsTotal: runs.length,
      runsPage: page,
    };
  });

  fastify.get(
    "/download/:division/:number",
    { compress: false },
    async (req, res) => {
      const { division, number } = req.params;
      const c = classifiers.find((cur) => cur.classifier === number);

      res.header(
        "Content-Disposition",
        `attachment; filename=classifiers.${division}.${number}.json`
      );

      if (!c) {
        res.statusCode = 404;
        return { info: null, runs: [] };
      }

      const basic = basicInfoForClassifier(c);
      const extended = await extendedInfoForClassifier(c, division);
      const { hhf, hhfs } = extended;

      return {
        info: {
          ...basic,
          ...extended,
        },
        runs: await runsForDivisionClassifier({
          number,
          division,
          hhf,
          includeNoHF: false,
          hhfs,
        }),
      };
    }
  );

  fastify.get("/:division/:number/chart", async (req, res) => {
    const { division, number } = req.params;
    const { full } = req.query;
    return await chartData({ division, number, full });
  });
};

export default classifiersRoutes;
