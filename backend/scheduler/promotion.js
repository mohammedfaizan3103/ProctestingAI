import Student from "../models/Student.js";

// Return cycle tag: 'YYYY-01' for January, 'YYYY-07' for July; null otherwise
function currentCycleTag(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0=Jan, 6=Jul
  if (m === 0) return `${y}-01`;
  if (m === 6) return `${y}-07`;
  return null;
}

async function runPromotionCycle() {
  const tag = currentCycleTag();
  if (!tag) return { semUpdated: 0, yearUpdated: 0, tag: null };

  const isJuly = tag.endsWith("-07");

  // Increment semester once per cycle
  const semResult = await Student.updateMany(
    {
      semester: { $gte: 1, $lt: 8 },
      // Prevent double-run within same cycle
      $or: [
        { lastSemCycle: { $exists: false } },
        { lastSemCycle: { $ne: tag } },
      ],
    },
    {
      $inc: { semester: 1 },
      $set: { lastSemCycle: tag },
    }
  );

  let yearResult = { modifiedCount: 0 };
  if (isJuly) {
    yearResult = await Student.updateMany(
      {
        year: { $gte: 1, $lt: 4 },
        $or: [
          { lastYearCycle: { $exists: false } },
          { lastYearCycle: { $ne: tag } },
        ],
      },
      {
        $inc: { year: 1 },
        $set: { lastYearCycle: tag },
      }
    );
  }

  return {
    semUpdated: semResult.modifiedCount || semResult.nModified || 0,
    yearUpdated: yearResult.modifiedCount || yearResult.nModified || 0,
    tag,
  };
}

function scheduleDailyRunner() {
  // Run immediately at startup
  runPromotionCycle().catch(() => {});
  // Then run every 12 hours; cycle guards prevent double increments
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  setInterval(() => {
    runPromotionCycle().catch(() => {});
  }, TWELVE_HOURS_MS);
}

export { scheduleDailyRunner, runPromotionCycle };
