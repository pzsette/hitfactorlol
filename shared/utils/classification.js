import { randomUUID } from "crypto";
import { mapDivisions } from "../../api/src/dataUtil/divisions.js";
import uniqBy from "lodash.uniqby";
import { dateSort, numSort } from "./sort.js";

export const classificationRank = (classification) =>
  ["X", "U", "D", "C", "B", "A", "M", "GM"].indexOf(classification);
/* const hasClassification = (classification) =>
  ["D", "C", "B", "A", "M", "GM"].indexOf(classification) !== -1; */

export const highestClassification = (classificationsObj) =>
  Object.values(classificationsObj).reduce((prev, curClass) => {
    if (classificationRank(prev) >= classificationRank(curClass)) {
      return prev;
    } else {
      return curClass;
    }
  }, undefined);

export const classForPercent = (curPercent) => {
  if (curPercent <= 0) {
    return "U";
  } else if (curPercent < 40) {
    return "D";
  } else if (curPercent < 60) {
    return "C";
  } else if (curPercent < 75) {
    return "B";
  } else if (curPercent < 85) {
    return "A";
  } else if (curPercent < 95) {
    return "M";
  } else if (curPercent >= 95) {
    return "GM";
  }

  return "U";
};

// B-class check, NOT used for initial classification
export const lowestAllowedPercentForClass = (classification) =>
  ({
    GM: 90,
    M: 80,
    A: 70,
    B: 55,
    C: 35,
  }[classification] || 0);

// C-class check, NOT used for initial classification
export const lowestAllowedPercentForOtherDivisionClass = (
  highestClassification
) =>
  ({
    GM: 85,
    M: 75,
    A: 60,
    B: 40,
  }[highestClassification] || 0);

export const canBeInserted = (c, state) => {
  const { division, classifier } = c;
  const { window } = state[division];
  const percentField = "percent"; // TODO: curPercent, recommendedPercent
  const percent = c[percentField];

  // zeros never count - instant B flag
  if (!c[percentField]) {
    return false;
  }

  // Looks like A-flag is gone
  const cFlagThreshold = lowestAllowedPercentForOtherDivisionClass(
    highestClassification(getDivToClass(state))
  );
  const isBFlag =
    percent <= lowestAllowedPercentForClass(getDivToClass(state)[division]);
  const isCFlag = percent <= cFlagThreshold;

  // First 4 always count
  if (window.length <= 4) {
    return true;
  }

  if (isCFlag || isBFlag) {
    return false;
  }

  // D, F, E
  return true;
};

// if true -- window doesn't have to shrink when inserting
export const hasDuplicateInWindow = (c, window) =>
  window.map((cur) => cur.classifier).includes(c.classifier);

export const hasDuplicate = (c, state) =>
  hasDuplicateInWindow(c, state[c.division].window);

export const numberOfDuplicates = (window) => {
  const table = {};
  window.forEach((c) => {
    const curCount = table[c.classifier] || 0;
    table[c.classifier] = curCount + 1;
  });
  return Object.values(table)
    .map((c) => c - 1)
    .reduce((acc, cur) => acc + cur, 0);
};

const windowSizeForScore = (windowSize) => {
  if (windowSize < 4) {
    return 0;
  } else if (windowSize === 4) {
    return 4;
  }

  return 6;
};

export const percentForDivWindow = (div, state, percentField = "percent") => {
  const window = state[div].window.toSorted((a, b) =>
    numSort(a, b, percentField, -1)
  );

  //de-dupe needs to be done in reverse, because percent are sorted asc
  const dFlagsApplied = uniqBy(window, (c) => c.classifier);

  // remove lowest 2
  const newLength = windowSizeForScore(dFlagsApplied.length);
  const fFlagsApplied = dFlagsApplied.slice(0, newLength);
  return fFlagsApplied.reduce(
    (acc, curValue, curIndex, allInWindow) =>
      acc + curValue[percentField] / allInWindow.length,
    0
  );
};

export const newClassificationCalculationState = () =>
  mapDivisions((div) => ({
    percent: 0,
    highPercent: 0,
    window: [],
  }));

// adds in place, growing window if needed for duplicates
export const addToCurWindow = (c, curWindow) => {
  // push, truncate the tail, then re-add tail partially for each duplicate
  curWindow.push(c);
  curWindow.reverse();
  const removed = curWindow.splice(8);
  curWindow.reverse();
  const extraWindowLength = numberOfDuplicates([...removed, ...curWindow]);
  const extraFromTail = removed.slice(0, extraWindowLength).reverse();
  curWindow.unshift(...extraFromTail);
};

// TODO: minimal class as highest - 1
export const calculateUSPSAClassification = (classifiers) => {
  const state = newClassificationCalculationState();

  const classifiersReadyToScore = classifiers
    .toSorted((a, b) => {
      const asDate = dateSort(a, b, "sd", 1);
      if (!asDate) {
        return numSort(a, b, "percent", 1);
      }
      return asDate;
    })
    .map((c) => ({
      ...c,
      classifier: c.source === "Major Match" ? randomUUID() : c.classifier,
    }));

  const scoringFunction = (c) => {
    if (!canBeInserted(c, state)) {
      return;
    }
    const { division } = c;
    const curWindow = state[c.division].window;

    addToCurWindow(c, curWindow);

    // Calculate if have enough classifiers
    if (curWindow.length >= 4) {
      const oldHighPercent = state[division].highPercent;
      const newPercent = percentForDivWindow(division, state);
      if (newPercent > oldHighPercent) {
        state[division].highPercent = newPercent;
      }
      state[division].percent = newPercent;
    }
  };

  classifiersReadyToScore.forEach(scoringFunction);

  return state;
};

export const getDivToClass = (state) =>
  mapDivisions((div) => classForPercent(state[div].highPercent));
