// js/missions.js
// デイリーミッション（毎日3つ）の進み具合を記録する
// 各画面から Missions.add("battle_win") のように呼ぶと、localStorage の user に保存される

const MISSION_POOL = [
    { id: 1, text: "バトルを1回プレイする", type: "battle_play", goal: 1, diff: "易" },
    { id: 2, text: "バトルで3回勝利する", type: "battle_win", goal: 3, diff: "中" },
    { id: 3, text: "カードを合計30枚プレイする", type: "cards_played", goal: 30, diff: "易" },
    { id: 4, text: "ランクマッチに2回挑戦する", type: "rank_play", goal: 2, diff: "易" },
    { id: 5, text: "フォロワーを10体召喚する", type: "followers", goal: 10, diff: "中" },
    { id: 6, text: "カードを1枚生成または分解する", type: "craft", goal: 1, diff: "易" },
    { id: 7, text: "デッキを保存する", type: "deck_save", goal: 1, diff: "易" },
];

const Missions = {
    REWARD: 100, // 1つあたりのコイン

    today() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    },

    // 日付が変わっていたら、新しいミッション3つに入れ替える
    ensureToday(user) {
        if (user.lastMissionDate !== Missions.today() || !Array.isArray(user.dailyMissions)) {
            user.lastMissionDate = Missions.today();
            user.claimedMissions = [];
            user.missionProgress = {};
            user.dailyMissions = [...MISSION_POOL].sort(() => Math.random() - 0.5).slice(0, 3);
        }
        // 以前の形式（type がない）で保存されていたら補う
        user.dailyMissions = user.dailyMissions.map((m) => m.type ? m : (MISSION_POOL.find((p) => p.id === m.id) || m));
        user.missionProgress = user.missionProgress || {};
        user.claimedMissions = user.claimedMissions || [];
        return user;
    },

    add(type, amount = 1) {
        if (!amount) return;
        const user = Missions.ensureToday(JSON.parse(localStorage.getItem("user") || "{}"));
        user.missionProgress[type] = (user.missionProgress[type] || 0) + amount;
        localStorage.setItem("user", JSON.stringify(user));
    },

    progress(user, mission) {
        return Math.min(mission.goal, (user.missionProgress || {})[mission.type] || 0);
    },

    isDone(user, mission) {
        return Missions.progress(user, mission) >= mission.goal;
    },
};
