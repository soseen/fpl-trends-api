import fs from "fs";
import { RAW_BOOTSTRAP_STATIC_FILE } from "../file.helpers.js";
import type { BootstrapStaticData } from "../bootstrapStatic/types.js";
import { prisma } from "./client.js";

export const insertFootballers = async () => {
  try {
    const rawData: BootstrapStaticData = fs.existsSync(
      RAW_BOOTSTRAP_STATIC_FILE,
    )
      ? JSON.parse(fs.readFileSync(RAW_BOOTSTRAP_STATIC_FILE, "utf8"))
      : {};

    for (const footballer of rawData.elements) {
      const footballerObject = {
        web_name: footballer.web_name,
        first_name: footballer.first_name,
        second_name: footballer.second_name,
        now_cost: footballer.now_cost,
        team_code: footballer.team_code,
        team_id: footballer.team,
        total_points: footballer.total_points,
        selected_by_percent: footballer.selected_by_percent,
        goals_scored: footballer.goals_scored,
        assists: footballer.assists,
        bonus: footballer.bonus,
        bps: footballer.bps,
        status: footballer.status,
        news: footballer.news,
        expected_goals: footballer.expected_goals,
        expected_assists: footballer.expected_assists,
        expected_goal_involvements: footballer.expected_goal_involvements,
        expected_goals_conceded: footballer.expected_goals_conceded,
        expected_goals_per_90: footballer.expected_goals_per_90,
        expected_assists_per_90: footballer.expected_assists_per_90,
        expected_goal_involvements_per_90:
          footballer.expected_goal_involvements_per_90,
        expected_goals_conceded_per_90:
          footballer.expected_goals_conceded_per_90,
        goals_conceded_per_90: footballer.goals_conceded_per_90,
        element_type: footballer.element_type,
        can_transact: footballer.can_transact,
        can_select: footballer.can_select,
        chance_of_playing_next_round: footballer.chance_of_playing_next_round,
        chance_of_playing_this_round: footballer.chance_of_playing_this_round,
        cost_change_event: footballer.cost_change_event,
        cost_change_event_fall: footballer.cost_change_event_fall,
        cost_change_start: footballer.cost_change_start,
        cost_change_start_fall: footballer.cost_change_start_fall,
        dreamteam_count: footballer.dreamteam_count,
        ep_next: footballer.ep_next,
        ep_this: footballer.ep_this,
        event_points: footballer.event_points,
        form: footballer.form,
        in_dreamteam: footballer.in_dreamteam,
        news_added: footballer.news_added,
        photo: footballer.photo,
        points_per_game: footballer.points_per_game,
        removed: footballer.removed,
        special: footballer.special,
        squad_number: footballer.squad_number,
        transfers_in: footballer.transfers_in,
        transfers_in_event: footballer.transfers_in_event,
        transfers_out: footballer.transfers_out,
        transfers_out_event: footballer.transfers_out_event,
        value_form: footballer.value_form,
        value_season: footballer.value_season,
        region: footballer.region,
        minutes: footballer.minutes,
        clean_sheets: footballer.clean_sheets,
        goals_conceded: footballer.goals_conceded,
        own_goals: footballer.own_goals,
        penalties_saved: footballer.penalties_saved,
        penalties_missed: footballer.penalties_missed,
        yellow_cards: footballer.yellow_cards,
        red_cards: footballer.red_cards,
        saves: footballer.saves,
        influence: footballer.influence,
        creativity: footballer.creativity,
        threat: footballer.threat,
        ict_index: footballer.ict_index,
        starts: footballer.starts,
        influence_rank: footballer.influence_rank,
        influence_rank_type: footballer.influence_rank_type,
        creativity_rank: footballer.creativity_rank,
        creativity_rank_type: footballer.creativity_rank_type,
        threat_rank: footballer.threat_rank,
        threat_rank_type: footballer.threat_rank_type,
        ict_index_rank: footballer.ict_index_rank,
        ict_index_rank_type: footballer.ict_index_rank_type,
        corners_and_indirect_freekicks_order:
          footballer.corners_and_indirect_freekicks_order,
        corners_and_indirect_freekicks_text:
          footballer.corners_and_indirect_freekicks_text,
        direct_freekicks_order: footballer.direct_freekicks_order,
        direct_freekicks_text: footballer.direct_freekicks_text,
        penalties_order: footballer.penalties_order,
        penalties_text: footballer.penalties_text,
        saves_per_90: footballer.saves_per_90,
        now_cost_rank: footballer.now_cost_rank,
        now_cost_rank_type: footballer.now_cost_rank_type,
        form_rank: footballer.form_rank,
        form_rank_type: footballer.form_rank_type,
        points_per_game_rank: footballer.points_per_game_rank,
        points_per_game_rank_type: footballer.points_per_game_rank_type,
        selected_rank: footballer.selected_rank,
        selected_rank_type: footballer.selected_rank_type,
        starts_per_90: footballer.starts_per_90,
        clean_sheets_per_90: footballer.clean_sheets_per_90,
      };
      await prisma.footballers.upsert({
        where: { code: footballer.code },
        update: footballerObject,
        create: {
          id: footballer.id,
          code: footballer.code,
          ...footballerObject,
        },
      });
    }
  } catch (error) {
    console.error(
      "Couldn't populate the footballers table. Error:",
      (error as Error)?.message,
    );
  } finally {
    console.info("Footballers populated successfully.");
    await prisma.$disconnect();
  }
};
