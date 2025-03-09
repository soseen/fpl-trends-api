import fs from "fs";
import { BootstrapStaticData } from "../bootstrapStatic/types.js";
import { RAW_BOOTSTRAP_STATIC_FILE } from "../file.helpers.js";
import { prisma } from "../database/client.js";

export const insertEvents = async () => {
  try {
    const rawData: BootstrapStaticData = fs.existsSync(
      RAW_BOOTSTRAP_STATIC_FILE,
    )
      ? JSON.parse(fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf8"))
      : {};

    for (const event of rawData.events) {
      if (!event.finished && !event.is_current) break;
      await prisma.events.upsert({
        where: { id: event.id },
        update: {
          name: event.name,
          average_entry_score: event.average_entry_score,
          finished: event.finished,
          data_checked: event.data_checked,
          highest_scoring_entry: event.highest_scoring_entry,
          deadline_time_epoch: event.deadline_time_epoch,
          deadline_time_game_offset: event.deadline_time_game_offset,
          highest_score: event.highest_score,
          is_previous: event.is_previous,
          is_current: event.is_current,
          is_next: event.is_next,
          cup_leagues_created: event.cup_leagues_created,
          h2h_ko_matches_created: event.h2h_ko_matches_created,
          can_enter: event.can_enter,
          can_manage: event.can_manage,
          released: event.released,
          ranked_count: event.ranked_count,
          most_selected: event.most_selected,
          most_transferred_in: event.most_transferred_in,
          top_element: event.top_element,
          transfers_made: event.transfers_made,
          most_captained: event.most_captained,
          most_vice_captained: event.most_vice_captained,
        },
        create: {
          id: event.id,
          name: event.name,
          average_entry_score: event.average_entry_score,
          finished: event.finished,
          data_checked: event.data_checked,
          highest_scoring_entry: event.highest_scoring_entry,
          deadline_time_epoch: event.deadline_time_epoch,
          deadline_time_game_offset: event.deadline_time_game_offset,
          highest_score: event.highest_score,
          is_previous: event.is_previous,
          is_current: event.is_current,
          is_next: event.is_next,
          cup_leagues_created: event.cup_leagues_created,
          h2h_ko_matches_created: event.h2h_ko_matches_created,
          can_enter: event.can_enter,
          can_manage: event.can_manage,
          released: event.released,
          ranked_count: event.ranked_count,
          most_selected: event.most_selected,
          most_transferred_in: event.most_transferred_in,
          top_element: event.top_element,
          transfers_made: event.transfers_made,
          most_captained: event.most_captained,
          most_vice_captained: event.most_vice_captained,
        },
      });
    }
    console.log("Events populated successfully.");
  } catch (error) {
    console.error("Error inserting events:", error);
  } finally {
    await prisma.$disconnect();
  }
};
