import { describe, expect, it } from "vitest";

import {
  DEFAULT_LADDER,
  isValidLadder,
  ladderOf,
  namedDailyPrice,
  numberWords,
  priceAtStage,
  priceMentions,
  spokenDailyRates,
  spokenPrice,
  spokenWholeDollars,
  stageOfPrice,
} from "./price-ladder";

describe("ladders", () => {
  it("validates like the control plane", () => {
    expect(isValidLadder([4, 3.5, 3.25, 3])).toBe(true);
    expect(isValidLadder([5])).toBe(true);
    for (const bad of [[], [3, 4], [4, 4], [4, 0], [4, -1], [101], [4.333], [1, 2, 3, 4, 5, 6, 7, 8, 9].reverse(), ["4"], null]) {
      expect(isValidLadder(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("a call without a ladder gets the demo's; an invalid one throws instead of being quoted", () => {
    expect(ladderOf(undefined)).toEqual([4, 3.5, 3.25, 3]);
    expect(ladderOf({ price_ladder: [5, 4.5, 4] })).toEqual([5, 4.5, 4]);
    expect(() => ladderOf({ price_ladder: [3, 4] })).toThrow(/invalid price ladder/);
  });

  it("stages", () => {
    expect(priceAtStage(DEFAULT_LADDER, 1)).toBe(4);
    expect(priceAtStage(DEFAULT_LADDER, 3)).toBe(3.25);
    expect(priceAtStage(DEFAULT_LADDER, 9)).toBe(3);
    expect(priceAtStage(DEFAULT_LADDER, undefined)).toBe(4);
    expect(stageOfPrice(DEFAULT_LADDER, 3.5)).toBe(2);
    expect(stageOfPrice(DEFAULT_LADDER, 3.4)).toBe(0);
  });
});

describe("words", () => {
  it("says the demo ladder exactly as the approved lines do", () => {
    expect(DEFAULT_LADDER.map(spokenPrice)).toEqual(["four dollars", "three dollars and fifty cents", "three dollars and twenty-five cents", "three dollars"]);
  });

  it("other amounts", () => {
    expect(spokenPrice(1)).toBe("one dollar");
    expect(spokenPrice(5.99)).toBe("five dollars and ninety-nine cents");
    expect(spokenPrice(0.75)).toBe("seventy-five cents");
    expect(spokenPrice(21.01)).toBe("twenty-one dollars and one cent");
    expect(numberWords(120)).toBe("one hundred and twenty");
    expect(numberWords(305)).toBe("three hundred and five");
    expect(spokenWholeDollars(97.5)).toBe("ninety-eight dollars");
  });
});

describe("prices in speech", () => {
  it.each([
    ["how about three fifty", 3.5],
    ["three twenty five?", 3.25],
    ["three twenty-five", 3.25],
    ["$3.25", 3.25],
    ["I'd pay 3.50", 3.5],
    ["three dollars and fifty cents", 3.5],
    ["three dollars fifty", 3.5],
    ["three and a half", 3.5],
    ["four bucks", 4],
    ["four dollars", 4],
    ["how about 3", 3],
    ["five seventy five", 5.75],
    ["twenty dollars a month", 0.67],
    ["20 a month", 0.67],
    ["twenty a month", 0.67],
    ["twenty dollars", 0.67],
    ["eight dollars a day", 8],
    // Max's price repeated back, then the customer's offer: the offer is the lower one
    ["Four dollars a day is too much. Can you do two dollars a day?", 2],
    ["four is too much, how about three fifty", 3.5],
  ])("%s -> %s", (said, price) => {
    expect(namedDailyPrice(said)).toBe(price);
  });

  it("numbers that are not prices", () => {
    for (const s of ["I bought a 2026 Mazda", "three years", "five twenty years", "yes", "the 10 year plan", "three people", "it's twenty miles away"]) {
      expect(namedDailyPrice(s), s).toBeNull();
    }
  });

  it("an amount far above the opening price with no unit is monthly", () => {
    expect(namedDailyPrice("twenty dollars", [25, 22, 20])).toBe(20);
    expect(namedDailyPrice("twenty dollars", [4, 3])).toBe(0.67);
  });

  it("rates Max says, with 'a day'", () => {
    expect(spokenDailyRates("four dollars a day, or $3.25 per day, three dollars and fifty cents a day")).toEqual([4, 3.25, 3.5]);
    expect(spokenDailyRates("five dollars and seventy-five cents a day")).toEqual([5.75]);
    expect(spokenDailyRates("Engine can cost up to $7,000 and labor is $130 per hour")).toEqual([]);
    expect(spokenDailyRates("a coffee from starbucks is 8 dollars and sixty cent")).toEqual([]);
  });

  it("mentions keep their period", () => {
    expect(priceMentions("ten dollars a month or 2 dollars daily")).toEqual([
      { amount: 10, per: "month", at: 0 },
      { amount: 2, per: "day", at: 23 },
    ]);
  });
});
