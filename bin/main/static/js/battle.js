// js/battle.js
// シャドバ風の対戦画面（描画・操作・演出・CPU）
// 読み込み順: effects.js → cards.js → battle.js
//
// ソロ（CPU戦）: battle.html を開くと、デッキ編成で保存したデッキ（localStorage）で始まる
//               ?class=魔女 を付けると、そのクラスのランダムデッキで始まる（動作確認用）
// ランクマッチ:  <body data-mode="rank"> にして、rank-match.js の onStart で BattleUI.attach(client) を呼ぶ

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// クラスごとの記号と色（カード絵の代わり）
const CLASS_STYLE = {
    [CLASS.NOBLE]:   { sigil: "♛", hue: 345, sat: 55 },
    [CLASS.MONSTER]: { sigil: "☠", hue: 12,  sat: 60 },
    [CLASS.GHOST]:   { sigil: "☾", hue: 200, sat: 35 },
    [CLASS.WITCH]:   { sigil: "✶", hue: 280, sat: 50 },
    [CLASS.PUPPET]:  { sigil: "♟", hue: 35,  sat: 40 },
    [CLASS.HUNTER]:  { sigil: "✚", hue: 140, sat: 35 },
    [CLASS.PIRATE]:  { sigil: "⚓", hue: 215, sat: 55 },
    [CLASS.NEUTRAL]: { sigil: "✦", hue: 48,  sat: 25 },
};

const KW_SHORT = {
    [KEYWORD.STORM]: "疾走",
    [KEYWORD.RUSH]: "突進",
    [KEYWORD.DRAIN]: "吸収",
    [KEYWORD.SHIELD]: "盾",
    [KEYWORD.WARD]: "守護",
};

// ===================================================================
// 効果音（Web Audio で鳴らすので音声ファイルは不要）
// ===================================================================
const GothicSoundManager = {
    audioCtx: null,
    init() {
        if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    },
    tone(type, from, to, gain, dur) {
        try {
            this.init();
            const t = this.audioCtx.currentTime;
            const o = this.audioCtx.createOscillator();
            const g = this.audioCtx.createGain();
            o.type = type;
            o.frequency.setValueAtTime(from, t);
            o.frequency.exponentialRampToValueAtTime(to, t + dur);
            g.gain.setValueAtTime(gain, t);
            g.gain.exponentialRampToValueAtTime(0.01, t + dur);
            o.connect(g);
            g.connect(this.audioCtx.destination);
            o.start();
            o.stop(t + dur);
        } catch (e) { /* 音が鳴らせない環境では何もしない */ }
    },
    playCard() { this.tone("sine", 400, 800, 0.3, 0.1); },
    playAttack() { this.tone("triangle", 150, 40, 0.5, 0.2); },
    playEvolve() { this.tone("sine", 300, 1200, 0.3, 0.35); },
    playGothicVictoryAnthem() {
        try {
            this.init();
            const now = this.audioCtx.currentTime;
            [130.81, 261.63, 392.0].forEach((freq) => {
                const bell = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                bell.type = "sine";
                bell.frequency.setValueAtTime(freq, now);
                gain.gain.setValueAtTime(0.5, now);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
                bell.connect(gain);
                gain.connect(this.audioCtx.destination);
                bell.start(now);
                bell.stop(now + 2.5);
            });
            [440.0, 554.37, 659.25, 880.0, 1108.73].forEach((freq, idx) => {
                const st = now + 0.4 + idx * 0.18;
                const o = this.audioCtx.createOscillator();
                const g = this.audioCtx.createGain();
                o.type = "triangle";
                o.frequency.setValueAtTime(freq, st);
                g.gain.setValueAtTime(0.35, st);
                g.gain.exponentialRampToValueAtTime(0.001, st + 1.2);
                o.connect(g);
                g.connect(this.audioCtx.destination);
                o.start(st);
                o.stop(st + 1.2);
            });
        } catch (e) { /* 何もしない */ }
    },
};

function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function hashStr(s) {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return Math.abs(h);
}

function artOf(card) {
    const st = CLASS_STYLE[card.class] || CLASS_STYLE[CLASS.NEUTRAL];
    const seed = card.id || hashStr(card.name);
    const h = (st.hue + ((seed * 37) % 40) - 20 + 360) % 360;
    const s = st.sat;
    return `radial-gradient(circle at 50% 28%, hsl(${h} ${s}% 40%), hsl(${h} ${s}% 15%) 58%, hsl(${h} ${s}% 5%))`;
}

// ===================================================================
// 画面の状態
// ===================================================================
const UI = {
    game: null,
    me: null,
    opp: null,
    ctrl: null,          // play / attack / evolve / activate / endTurn / canAct を持つもの
    selectedUid: null,   // クリックで選んだ自分のカード（進化ボタン表示用）
    targeting: null,     // 対象選択中: { keys:Set, resolve }
    drag: null,
    snap: null,          // 前回描画時の体力（ダメージ表示用）
    rects: new Map(),    // 前回描画時のカード位置（破壊演出用）
    flashUid: null,
    logs: [],
    ended: false,
};

const BattleUI = {
    // ctrl: MatchClient でも SoloController でもよい
    attach(ctrl) {
        UI.ctrl = ctrl;
        UI.game = ctrl.game;
        UI.me = ctrl.me;
        UI.opp = UI.game.getOpponent(UI.me);
        $("opp-name").textContent = UI.opp.name;
        $("my-name").textContent = UI.me.name;
        render();
    },
    render: () => render(),
    showResult: (isWin) => showResult(isWin),
    banner: (text, enemy) => banner(text, enemy),
    reveal: (viewer, cards) => reveal(viewer, cards),
    log: (msg) => addLog(msg),
};

// ===================================================================
// 描画
// ===================================================================
function render() {
    const { game, me, opp } = UI;
    if (!game) return;

    // 前回の位置を記録（破壊されたカードの演出に使う）
    const oldRects = new Map();
    document.querySelectorAll(".field .card").forEach((el) => {
        oldRects.set(Number(el.dataset.uid), { rect: el.getBoundingClientRect(), html: el.outerHTML });
    });
    const prevFieldUids = new Set(oldRects.keys());

    renderLeader(opp, "opp");
    renderLeader(me, "my");
    renderField(opp, $("opp-field"), false, prevFieldUids);
    renderField(me, $("my-field"), true, prevFieldUids);
    renderHand();
    renderOppHand();
    renderInfo(me, "my");
    renderInfo(opp, "opp");
    renderEndTurn();
    renderTargeting();
    $("turn-count").textContent = Math.max(1, me.turnCount);

    // 破壊・消滅したカードの演出
    const alive = new Set([...me.field, ...opp.field].map((c) => c.uid));
    oldRects.forEach((v, uid) => {
        if (alive.has(uid)) return;
        const holder = document.createElement("div");
        holder.innerHTML = v.html;
        const ghost = holder.firstElementChild;
        ghost.classList.remove("can-attack", "selected", "targetable", "enter");
        ghost.classList.add("dying");
        ghost.style.left = v.rect.left + "px";
        ghost.style.top = v.rect.top + "px";
        ghost.style.width = v.rect.width + "px";
        ghost.querySelectorAll(".card-action").forEach((b) => b.remove());
        $("fx-layer").appendChild(ghost);
        setTimeout(() => ghost.remove(), 600);
    });

    showDamageNumbers();
}

function renderLeader(player, side) {
    $(`${side}-hp`).textContent = player.leader.hp;
    const el = $(`${side}-leader`);
    el.classList.toggle("low", player.leader.hp <= 10);
    const portrait = el.querySelector(".leader-portrait");
    const cls = player.deckClass || CLASS.NEUTRAL;
    const st = CLASS_STYLE[cls] || CLASS_STYLE[CLASS.NEUTRAL];
    portrait.style.setProperty("--art", `radial-gradient(circle at 50% 35%, hsl(${st.hue} ${st.sat}% 30%), hsl(${st.hue} ${st.sat}% 8%) 70%)`);
    portrait.textContent = st.sigil;
}

function cardEl(card, where) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.uid = card.uid;
    const st = CLASS_STYLE[card.class] || CLASS_STYLE[CLASS.NEUTRAL];
    const isSpell = card.type === TYPE.SPELL;
    if (isSpell) el.classList.add("spell");

    let gems = "";
    if (where === "hand") {
        const cost = Rules.costOf(UI.game, UI.me, card);
        gems += `<div class="gem cost">${cost}</div>`;
    }
    if (!isSpell) {
        const base = CARD_MAP.get(card.id);
        const atk = where === "field" ? Rules.attackOf(UI.game, card) : card.attack;
        const atkCls = base && atk > base.attack ? "buffed" : base && atk < base.attack ? "damaged" : "";
        const hpCls = card.hp < card.maxHp ? "damaged" : base && card.hp > base.hp ? "buffed" : "";
        gems += `<div class="gem atk ${atkCls}">${atk}</div><div class="gem hp ${hpCls}">${card.hp}</div>`;
    }

    let badges = "";
    if (where === "field") {
        const list = [];
        for (const kw of [KEYWORD.STORM, KEYWORD.RUSH, KEYWORD.DRAIN]) if (card.keywords.has(kw)) list.push(KW_SHORT[kw]);
        if (card.statuses.some((s) => s.type === "CURSE")) list.push("呪");
        if (card.statuses.some((s) => s.type === "SILENCE")) list.push("封");
        if (card.attacksPerTurn > 1) list.push(`${card.attacksPerTurn}回`);
        if (list.length) badges = `<div class="badges">${list.map((b) => `<span class="badge">${b}</span>`).join("")}</div>`;
    }

    el.innerHTML = `
        <div class="art" style="--art:${artOf(card)}">
            <div class="glyph">${esc(card.name[0])}</div>
            <div class="sigil">${st.sigil}</div>
        </div>
        <div class="name">${esc(card.name)}</div>
        ${gems}${badges}`;
    return el;
}

function hasAttackTarget(card) {
    if (!Rules.canAttack(card)) return false;
    if (Rules.canAttackLeader(UI.game, card)) return true;
    return UI.opp.field.some((d) => Rules.canAttackFollower(UI.game, card, d));
}

function renderField(player, box, mine, prevUids) {
    box.innerHTML = "";
    const myTurn = UI.ctrl && UI.ctrl.canAct();
    for (const card of player.field) {
        const el = cardEl(card, "field");
        if (card.keywords.has(KEYWORD.WARD)) el.classList.add("ward");
        if (card.keywords.has(KEYWORD.SHIELD)) el.classList.add("shield");
        if (Fx.isStunned(card)) el.classList.add("stunned");
        if (card.evolved) el.classList.add("evolved");
        if (!prevUids.has(card.uid)) el.classList.add("enter");
        if (UI.flashUid === card.uid) el.classList.add("evolve-flash");

        if (mine && myTurn && !UI.targeting && hasAttackTarget(card)) {
            el.classList.add("can-attack");
            if (card.summonedThisTurn && card.keywords.has(KEYWORD.STORM)) el.classList.add("ready-storm");
        }
        if (mine && UI.selectedUid === card.uid && myTurn && !UI.targeting) {
            el.classList.add("selected");
            if (Rules.canEvolve(UI.me, card)) {
                el.insertAdjacentHTML("beforeend", `<button class="card-action evolve" data-action="evolve" type="button">進化</button>`);
            }
            if (card.activate) {
                el.insertAdjacentHTML("beforeend", `<button class="card-action activate" data-action="activate" type="button">起動</button>`);
            }
        }
        box.appendChild(el);
    }
}

function renderHand() {
    const box = $("hand");
    box.innerHTML = "";
    const hand = UI.me.hand;
    const n = hand.length;
    const canAct = UI.ctrl && UI.ctrl.canAct() && !UI.targeting;
    const cardW = box.clientWidth / 6.2;
    const spacing = Math.min(cardW * 0.82, (box.clientWidth - cardW) / Math.max(n - 1, 1));
    hand.forEach((card, i) => {
        const el = cardEl(card, "hand");
        const off = i - (n - 1) / 2;
        el.style.setProperty("--x", `${off * spacing}px`);
        el.style.setProperty("--y", `${off * off * 2}px`);
        el.style.setProperty("--r", `${off * 3}deg`);
        el.style.zIndex = 10 + i;
        if (canAct && Rules.canPlay(UI.game, UI.me, card)) el.classList.add("playable");
        if (UI.drag && UI.drag.card === card && UI.drag.moved) el.classList.add("dragging");
        box.appendChild(el);
    });
}

function renderOppHand() {
    const box = $("opp-hand");
    box.innerHTML = "";
    for (let i = 0; i < UI.opp.hand.length; i++) {
        const b = document.createElement("div");
        b.className = "card-back";
        box.appendChild(b);
    }
}

function evolveOpen(player) {
    const startTurn = player.isFirst ? 4 : 3;
    return player.evolvePoints > 0 && !player.evolvedThisTurn && player.turnCount >= startTurn;
}

function renderInfo(player, side) {
    $(`${side}-deck`).textContent = player.deck.length;
    $(`${side}-pp`).textContent = `${player.pp}/${player.maxPp}`;
    const ep = $(`${side}-ep`);
    ep.innerHTML = `<span class="ep-label">EP</span>` +
        Array.from({ length: EVOLVE_POINTS }, (_, i) => `<span class="ep-orb ${i < player.evolvePoints ? "on" : ""}"></span>`).join("");
    ep.classList.toggle("active", UI.game.current === player && evolveOpen(player));
    if (side === "my") {
        $("my-pp-orbs").innerHTML = Array.from({ length: MAX_PP }, (_, i) =>
            `<span class="pp-orb ${i < player.maxPp ? "max" : ""} ${i < player.pp ? "on" : ""}"></span>`).join("");
    }
}

function renderEndTurn() {
    const btn = $("end-turn");
    const canAct = UI.ctrl && UI.ctrl.canAct() && !UI.targeting;
    btn.disabled = !canAct;
    btn.querySelector(".end-turn-label").textContent = UI.game.current === UI.me ? "ターン終了" : "相手のターン";
    const nothingLeft = canAct &&
        !UI.me.hand.some((c) => Rules.canPlay(UI.game, UI.me, c)) &&
        !UI.me.field.some((c) => hasAttackTarget(c));
    btn.classList.toggle("done", nothingLeft);
}

function renderTargeting() {
    const t = UI.targeting;
    $("target-hint").classList.toggle("hidden", !t);
    $("opp-leader").classList.toggle("targetable", !!t && t.keys.has("opp-leader"));
    $("my-leader").classList.toggle("targetable", !!t && t.keys.has("my-leader"));
    if (!t) return;
    $("target-hint-text").textContent = t.hint;
    document.querySelectorAll(".field .card").forEach((el) => {
        el.classList.toggle("targetable", t.keys.has(Number(el.dataset.uid)));
    });
}

// ダメージ・回復の数字を出す
function showDamageNumbers() {
    const { me, opp } = UI;
    const now = new Map();
    [...me.field, ...opp.field].forEach((c) => now.set(c.uid, c.hp));
    now.set("my-leader", me.leader.hp);
    now.set("opp-leader", opp.leader.hp);

    if (UI.snap) {
        now.forEach((hp, key) => {
            if (!UI.snap.has(key)) return;
            const diff = hp - UI.snap.get(key);
            if (diff === 0) return;
            const el = typeof key === "number"
                ? document.querySelector(`.field .card[data-uid="${key}"]`)
                : $(key).querySelector(".leader-frame");
            if (!el) return;
            floatNum(el, diff);
            if (typeof key === "string" && diff < 0) {
                const leader = $(key);
                leader.classList.remove("shake");
                void leader.offsetWidth;
                leader.classList.add("shake");
            }
        });
        // 破壊されたカードは最後の体力からのダメージを出す
        UI.snap.forEach((hp, key) => {
            if (typeof key !== "number" || now.has(key)) return;
            const r = UI.rects.get(key);
            if (r) floatNumAt(r.left + r.width / 2, r.top + r.height / 2, -Math.max(hp, 1));
        });
    }
    UI.snap = now;
    UI.rects = new Map();
    document.querySelectorAll(".field .card").forEach((el) => UI.rects.set(Number(el.dataset.uid), el.getBoundingClientRect()));
}

function floatNum(el, diff) {
    const r = el.getBoundingClientRect();
    floatNumAt(r.left + r.width / 2, r.top + r.height / 2, diff);
}

function floatNumAt(x, y, diff) {
    const n = document.createElement("div");
    n.className = `float-num ${diff < 0 ? "dmg" : "heal"}`;
    n.textContent = diff < 0 ? diff : `+${diff}`;
    n.style.left = x + "px";
    n.style.top = y + "px";
    $("fx-layer").appendChild(n);
    setTimeout(() => n.remove(), 1000);
}

// ===================================================================
// カード詳細
// ===================================================================
function showDetail(card) {
    const d = $("detail");
    const isSpell = card.type === TYPE.SPELL;
    const kws = card.keywords ? [...card.keywords] : [];
    const atk = isSpell ? "" : (UI.game && UI.me.field.concat(UI.opp.field).includes(card) ? Rules.attackOf(UI.game, card) : card.attack);
    d.innerHTML = `
        <div class="d-head">
            <div class="d-cost">${card.cost}</div>
            <div>
                <div class="d-name">${esc(card.name)}</div>
                <div class="d-sub">${esc(card.class)} ・ ${isSpell ? "魔法" : "クリーチャー"}${card.isAce ? " ・ エース" : ""}${card.isToken ? " ・ トークン" : ""}</div>
            </div>
        </div>
        ${isSpell ? "" : `<div class="d-stats"><span class="a">⚔ ${atk}</span>　<span class="h">❤ ${card.hp}${card.hp !== card.maxHp ? ` / ${card.maxHp}` : ""}</span></div>`}
        ${kws.length ? `<div class="d-kw">${kws.map((k) => `<span>${esc(k)}</span>`).join("")}</div>` : ""}
        <div class="d-text">${esc(card.desc || "（効果なし）")}</div>
        ${card.evolveDesc ? `<div class="d-evolve">【進化時】${esc(card.evolveDesc)}</div>` : ""}
        ${card.implemented === false ? `<div class="d-todo">※この効果は未実装です</div>` : ""}`;
    d.classList.remove("hidden");
}

function hideDetail() {
    if (UI.detailPinned) return;
    $("detail").classList.add("hidden");
}

function findCard(uid) {
    for (const p of [UI.me, UI.opp]) {
        for (const zone of [p.field, p.hand]) {
            const c = zone.find((x) => x.uid === uid);
            if (c) return c;
        }
    }
    return null;
}

// ===================================================================
// 対象選択・選択肢
// ===================================================================
function keyOf(obj) {
    if (obj === UI.opp.leader) return "opp-leader";
    if (obj === UI.me.leader) return "my-leader";
    return obj.uid;
}

function objOf(key) {
    if (key === "opp-leader") return UI.opp.leader;
    if (key === "my-leader") return UI.me.leader;
    return findCard(key);
}

function validTargets(spec, filter, self) {
    const f = filter || (() => true);
    switch (spec) {
        case TARGET.ALLY_FOLLOWER: return UI.me.field.filter(f);
        case TARGET.ALLY_FOLLOWER_OTHER: return UI.me.field.filter((c) => c !== self).filter(f);
        case TARGET.ENEMY_FOLLOWER: return UI.opp.field.filter(f);
        case TARGET.ENEMY_ANY: return [...UI.opp.field.filter(f), UI.opp.leader];
        default: return [];
    }
}

function pickTarget(list, hint) {
    return new Promise((resolve) => {
        UI.targeting = { keys: new Set(list.map(keyOf)), resolve, hint };
        render();
    });
}

function endTargeting(result) {
    const t = UI.targeting;
    UI.targeting = null;
    render();
    if (t) t.resolve(result);
}

function chooseModal(title, choices) {
    return new Promise((resolve) => {
        const box = $("modal-box");
        box.innerHTML = `<h3>${esc(title)}</h3><div class="choices">${choices.map((c, i) => `<button type="button" data-i="${i}">${esc(c)}</button>`).join("")}</div>
            <div style="margin-top:2vh"><button type="button" data-i="-1">キャンセル</button></div>`;
        $("modal").classList.remove("hidden");
        box.onclick = (e) => {
            const b = e.target.closest("button");
            if (!b) return;
            $("modal").classList.add("hidden");
            const i = Number(b.dataset.i);
            resolve(i < 0 ? null : choices[i]);
        };
    });
}

// 「相手の手札を見る」などの効果
function reveal(viewer, cards) {
    if (viewer !== UI.me || !cards.length) return;
    const box = $("modal-box");
    box.innerHTML = `<h3>カードを確認</h3><div class="peek-row"></div><button type="button">閉じる</button>`;
    const row = box.querySelector(".peek-row");
    cards.forEach((c) => row.appendChild(cardEl(c, "peek")));
    $("modal").classList.remove("hidden");
    box.onclick = (e) => {
        if (e.target.closest("button")) $("modal").classList.add("hidden");
    };
}

// ===================================================================
// 操作
// ===================================================================
async function beginPlay(card) {
    let choice;
    if (card.choices) {
        choice = await chooseModal(`${card.name}：効果を選ぶ`, card.choices);
        if (choice == null) return;
    }
    let target;
    const skipTarget = choice === "回復";
    if (card.target && !card.targetCount && !skipTarget) {
        const list = validTargets(card.target, card.targetFilter, null);
        if (list.length) {
            target = await pickTarget(list, `${card.name}：対象を選んでください`);
            if (target === undefined) return;
        }
    }
    if (UI.ctrl.play(card, { target, choice }) !== false) GothicSoundManager.playCard();
    afterAction();
}

async function beginEvolve(card) {
    let target;
    if (card.evolveTarget) {
        const list = validTargets(card.evolveTarget, null, card);
        if (list.length) {
            target = await pickTarget(list, `${card.name}：進化時の対象を選んでください`);
            if (target === undefined) return;
        }
    }
    UI.selectedUid = null;
    UI.flashUid = card.uid;
    GothicSoundManager.playEvolve();
    UI.ctrl.evolve(card, { target });
    afterAction();
    setTimeout(() => { UI.flashUid = null; }, 900);
}

async function doAttack(attacker, defender) {
    UI.selectedUid = null;
    await animateAttack(attacker, defender);
    GothicSoundManager.playAttack();
    addLog(`${attacker.name} → ${defender.isLeader ? "リーダー" : defender.name}`);
    UI.ctrl.attack(attacker, defender);
    afterAction();
}

function afterAction() {
    render();
    checkEnd();
}

async function animateAttack(attacker, defender) {
    const a = document.querySelector(`.field .card[data-uid="${attacker.uid}"]`);
    const d = defender.isLeader
        ? (defender === UI.opp.leader ? $("opp-leader") : $("my-leader")).querySelector(".leader-frame")
        : document.querySelector(`.field .card[data-uid="${defender.uid}"]`);
    if (!a || !d) return;
    const ra = a.getBoundingClientRect();
    const rd = d.getBoundingClientRect();
    const dx = (rd.left + rd.width / 2) - (ra.left + ra.width / 2);
    const dy = (rd.top + rd.height / 2) - (ra.top + ra.height / 2);
    a.style.zIndex = 30;
    a.animate([
        { transform: "none" },
        { transform: `translate(${dx * 0.75}px, ${dy * 0.75}px) scale(1.12)`, offset: 0.55 },
        { transform: "none" },
    ], { duration: 420, easing: "ease-in-out" });
    await sleep(240);
}

// ----- ポインター操作（ドラッグでプレイ・矢印で攻撃） -----
function boardPoint(e) {
    return { x: e.clientX, y: e.clientY };
}

function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function onPointerDown(e) {
    if (UI.ended || e.button > 0) return;
    if (e.target.closest(".card-action, #end-turn, .modal, .target-hint")) return;
    if (UI.targeting) return; // 対象選択はクリックで処理
    const el = e.target.closest(".card");
    if (!el || !UI.ctrl.canAct()) return;
    const uid = Number(el.dataset.uid);

    if (el.parentElement.id === "hand") {
        const card = UI.me.hand.find((c) => c.uid === uid);
        if (card && Rules.canPlay(UI.game, UI.me, card)) {
            UI.drag = { kind: "play", card, el, start: boardPoint(e), moved: false };
        }
    } else if (el.parentElement.id === "my-field") {
        const card = UI.me.field.find((c) => c.uid === uid);
        if (!card) return;
        UI.drag = { kind: hasAttackTarget(card) ? "attack" : "click", card, el, start: boardPoint(e), moved: false };
    }
    if (UI.drag) e.preventDefault();
}

function onPointerMove(e) {
    const drag = UI.drag;
    if (!drag) return;
    const p = boardPoint(e);
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 8) {
        drag.moved = true;
        if (drag.kind === "play") {
            drag.ghost = cardEl(drag.card, "hand");
            $("drag-layer").appendChild(drag.ghost);
            drag.el.classList.add("dragging");
            hideDetail();
        }
    }
    if (!drag.moved) return;

    if (drag.kind === "play") {
        drag.ghost.style.left = p.x + "px";
        drag.ghost.style.top = p.y + "px";
        $("my-field").classList.toggle("drop-ok", p.y < window.innerHeight * 0.78);
    } else if (drag.kind === "attack") {
        drawArrow(centerOf(drag.el), p);
        document.querySelectorAll(".target-hover").forEach((x) => x.classList.remove("target-hover"));
        const t = attackTargetAt(p, drag.card);
        if (t) t.el.classList.add("target-hover");
    }
}

// 攻撃の矢印（少し弧を描く）
function drawArrow(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(80, len * 0.25);
    const cx = (from.x + to.x) / 2 - (dy / len) * bend;
    const cy = (from.y + to.y) / 2 + (dx / len) * bend * 0.3 - bend * 0.5;
    const path = $("arrow-path");
    path.setAttribute("d", `M${from.x},${from.y} Q${cx},${cy} ${to.x},${to.y}`);
    path.setAttribute("stroke-width", Math.max(6, window.innerHeight * 0.011));
}

function attackTargetAt(p, attacker) {
    const under = document.elementFromPoint(p.x, p.y);
    if (!under) return null;
    const leaderEl = under.closest("#opp-leader");
    if (leaderEl && Rules.canAttackLeader(UI.game, attacker)) return { el: leaderEl.querySelector(".leader-frame"), obj: UI.opp.leader };
    const cardEl = under.closest("#opp-field .card");
    if (cardEl) {
        const def = UI.opp.field.find((c) => c.uid === Number(cardEl.dataset.uid));
        if (def && Rules.canAttackFollower(UI.game, attacker, def)) return { el: cardEl, obj: def };
    }
    return null;
}

function onPointerUp(e) {
    const drag = UI.drag;
    if (!drag) return;
    UI.drag = null;
    const p = boardPoint(e);
    $("arrow-path").setAttribute("d", "");
    $("my-field").classList.remove("drop-ok");
    document.querySelectorAll(".target-hover").forEach((x) => x.classList.remove("target-hover"));
    if (drag.ghost) drag.ghost.remove();
    drag.el.classList.remove("dragging");

    if (drag.kind === "play") {
        if (drag.moved && p.y < window.innerHeight * 0.78) beginPlay(drag.card);
        else render();
        return;
    }
    if (drag.kind === "attack" && drag.moved) {
        const t = attackTargetAt(p, drag.card);
        if (t) doAttack(drag.card, t.obj);
        return;
    }
    // クリック: 選択の切り替え（進化ボタンを出す）
    UI.selectedUid = UI.selectedUid === drag.card.uid ? null : drag.card.uid;
    render();
}

function onClick(e) {
    // 進化・起動ボタン
    const action = e.target.closest(".card-action");
    if (action) {
        const uid = Number(action.closest(".card").dataset.uid);
        const card = UI.me.field.find((c) => c.uid === uid);
        if (!card) return;
        if (action.dataset.action === "evolve") beginEvolve(card);
        if (action.dataset.action === "activate") {
            UI.selectedUid = null;
            UI.ctrl.activate(card, {});
            afterAction();
        }
        return;
    }
    // 対象選択中
    if (UI.targeting) {
        const leader = e.target.closest(".leader");
        const cardEl = e.target.closest(".field .card");
        let key = null;
        if (leader) key = leader.id === "opp-leader" ? "opp-leader" : "my-leader";
        else if (cardEl) key = Number(cardEl.dataset.uid);
        if (key != null && UI.targeting.keys.has(key)) endTargeting(objOf(key));
        return;
    }
    // 何もない所をクリックしたら選択解除
    if (!e.target.closest(".card") && UI.selectedUid != null) {
        UI.selectedUid = null;
        render();
    }
}

function onPointerOver(e) {
    if (UI.drag && UI.drag.moved) return;
    const el = e.target.closest(".card");
    if (!el || el.closest("#drag-layer, #fx-layer, .modal")) return;
    const card = findCard(Number(el.dataset.uid));
    if (card) showDetail(card);
}

function onPointerOut(e) {
    const el = e.target.closest(".card");
    if (el && !el.contains(e.relatedTarget)) hideDetail();
}

// ===================================================================
// バナー・ログ・勝敗
// ===================================================================
function banner(text, enemy = false) {
    const b = $("banner");
    $("banner-text").textContent = text;
    b.classList.toggle("enemy", enemy);
    b.classList.remove("hidden");
    b.style.animation = "none";
    void b.offsetWidth;
    b.style.animation = "";
    return sleep(1300).then(() => b.classList.add("hidden"));
}

function addLog(msg) {
    UI.logs.push(msg);
    if (UI.logs.length > 7) UI.logs.shift();
    $("log").innerHTML = UI.logs.map((m) => `<div>${esc(m)}</div>`).join("");
}

function checkEnd() {
    const winner = Rules.winner(UI.game);
    if (!winner || UI.ended) return !!winner;
    if (!(UI.ctrl instanceof SoloController)) return true; // ランクマッチは MatchClient の onGameOver で表示
    showResult(winner === UI.me);
    return true;
}

function showResult(isWin) {
    if (UI.ended) return;
    UI.ended = true;
    $("modal").classList.add("hidden");
    if (UI.targeting) endTargeting(undefined);

    const data = isWin ? handleBattleVictory() : handleBattleDefeat();
    // サーバーにも結果を送りたい場合は window.onBattleEnd を定義する
    if (typeof window.onBattleEnd === "function") window.onBattleEnd(isWin, UI.game, data);

    if (isWin) {
        GothicSoundManager.playGothicVictoryAnthem();
        setTimeout(() => {
            $("gothic-cross").classList.remove("hidden");
            setTimeout(() => {
                $("gothic-cross").classList.add("hidden");
                showResultModal(true, data);
            }, 2800);
        }, 700);
    } else {
        setTimeout(() => showResultModal(false, data), 900);
    }
}

// 勝利時の戦績更新（localStorage の user）
function handleBattleVictory() {
    const user = JSON.parse(localStorage.getItem("user") || "{}");
    const oldMp = user.mp || 0;
    const oldRank = typeof getRankInfo === "function" ? getRankInfo(oldMp) : { name: "Beginner 0" };

    user.totalBattles = (user.totalBattles || 0) + 1;
    user.wins = (user.wins || 0) + 1;
    user.winStreak = (user.winStreak || 0) + 1;
    if (!user.classWins) user.classWins = { noble: 0, monster: 0, ghost: 0, witch: 0, doll: 0, hunter: 0, pirate: 0 };
    user.classWins[UI.deckClassKey] = (user.classWins[UI.deckClassKey] || 0) + 1;

    const group = typeof getGroupInfo === "function" ? getGroupInfo(user.winStreak) : { mpBonus: 100, name: "エメラルド" };
    const mpGain = group.mpBonus || 100;
    const coinGain = 150;
    user.mp = oldMp + mpGain;
    user.coin = (user.coin || 0) + coinGain;
    localStorage.setItem("user", JSON.stringify(user));

    const newRank = typeof getRankInfo === "function" ? getRankInfo(user.mp) : { name: "Beginner 0" };
    return {
        mpGain,
        coinGain,
        winStreak: user.winStreak,
        groupName: group.name,
        isRankUp: oldRank.name !== newRank.name,
        newRankName: newRank.name,
    };
}

// 敗北時の戦績更新
function handleBattleDefeat() {
    const user = JSON.parse(localStorage.getItem("user") || "{}");
    const mpLoss = Math.min(30, user.mp || 0);
    user.totalBattles = (user.totalBattles || 0) + 1;
    user.losses = (user.losses || 0) + 1;
    user.winStreak = 0;
    user.mp = Math.max(0, (user.mp || 0) - 30);
    localStorage.setItem("user", JSON.stringify(user));
    return { mpGain: -mpLoss, coinGain: 0, winStreak: 0, groupName: "", isRankUp: false, newRankName: "" };
}

function showResultModal(isWin, data) {
    const r = $("result");
    r.classList.toggle("lose", !isWin);
    $("result-title").textContent = isWin ? (data.isRankUp ? "RANK UP!" : "VICTORY") : "DEFEAT";
    $("result-sub").textContent = isWin ? (data.isRankUp ? "新たな高みへ到達しました" : "栄光の凱旋") : "闇に呑まれた…";
    const mp = $("res-mp");
    mp.textContent = isWin ? `+${data.mpGain} MP${data.groupName ? ` (${data.groupName})` : ""}` : `${data.mpGain} MP`;
    mp.classList.toggle("minus", !isWin);
    $("res-coin").textContent = `+${data.coinGain}`;
    $("res-streak").textContent = isWin ? `${data.winStreak} 連勝中` : "連勝リセット";
    $("res-rank-row").classList.toggle("hidden", !data.isRankUp);
    $("res-rank").textContent = data.newRankName;
    r.classList.remove("hidden");
}

// ===================================================================
// ソロ（CPU戦）
// ===================================================================
class SoloController {
    constructor(game, me, cpu) {
        this.game = game;
        this.me = me;
        this.cpu = cpu;
        this.busy = false;
    }

    canAct() {
        return !this.busy && !UI.ended && !Rules.winner(this.game) && this.game.current === this.me;
    }

    play(card, opts) {
        return this.canAct() && Rules.playCard(this.game, this.me, card, opts);
    }

    attack(attacker, defender) {
        return this.canAct() && Rules.attack(this.game, attacker, defender);
    }

    evolve(card, opts) {
        if (!this.canAct()) return false;
        const ok = Rules.evolve(this.game, this.me, card, opts);
        if (ok) addLog(`${card.name} が進化`);
        return ok;
    }

    activate(card, opts) {
        return this.canAct() && Rules.activate(this.game, this.me, card, opts);
    }

    async endTurn() {
        if (!this.canAct()) return;
        this.busy = true;
        UI.selectedUid = null;
        Rules.endTurn(this.game, this.me);
        render();
        if (checkEnd()) return;
        await this.cpuTurn();
        if (checkEnd()) return;
        Rules.startTurn(this.game, this.me);
        render();
        await banner("YOUR TURN");
        this.busy = false;
        render();
    }

    async cpuTurn() {
        const { game, cpu } = this;
        Rules.startTurn(game, cpu);
        render();
        await banner("ENEMY TURN", true);
        await runCpu(game, cpu, this.me);
        if (Rules.winner(game)) return;
        Rules.endTurn(game, cpu);
        render();
        await sleep(300);
    }
}

// ----- CPU の思考 -----
function cpuPickTarget(spec, filter, game, cpu, enemy, self) {
    const f = filter || (() => true);
    const byThreat = (a, b) => Rules.attackOf(game, b) - Rules.attackOf(game, a);
    switch (spec) {
        case TARGET.ENEMY_FOLLOWER: return enemy.field.filter(f).sort(byThreat)[0];
        case TARGET.ENEMY_ANY: return enemy.field.filter(f).sort(byThreat)[0] || enemy.leader;
        case TARGET.ALLY_FOLLOWER: return cpu.field.filter(f).sort(byThreat)[0];
        case TARGET.ALLY_FOLLOWER_OTHER: return cpu.field.filter((c) => c !== self).filter(f).sort(byThreat)[0];
        default: return undefined;
    }
}

// 難易度: localStorage の aiDifficulty（"normal" / "hard"）
function aiDifficulty() {
    return localStorage.getItem("aiDifficulty") || "normal";
}

function cpuChooseAttack(game, atk, cpu, enemy) {
    const power = Rules.attackOf(game, atk);
    // normal は3割くらいの確率で、狙いをランダムにする（hard は常に最善手）
    if (aiDifficulty() !== "hard" && Math.random() < 0.3) {
        const options = [
            ...(Rules.canAttackLeader(game, atk) ? [enemy.leader] : []),
            ...enemy.field.filter((d) => Rules.canAttackFollower(game, atk, d)),
        ];
        if (options.length) return options[Math.floor(Math.random() * options.length)];
    }
    const leaderOk = Rules.canAttackLeader(game, atk);
    const foes = enemy.field.filter((d) => Rules.canAttackFollower(game, atk, d));

    // とどめを刺せるならリーダーへ
    if (leaderOk) {
        const total = cpu.field.filter((c) => Rules.canAttackLeader(game, c)).reduce((s, c) => s + Rules.attackOf(game, c), 0);
        if (total >= enemy.leader.hp) return enemy.leader;
    }
    // 倒せて生き残れる相手を優先
    const goodTrade = foes
        .filter((d) => power >= d.hp && (Rules.attackOf(game, d) < atk.hp || atk.noDamageWhenAttacking))
        .sort((a, b) => Rules.attackOf(game, b) - Rules.attackOf(game, a))[0];
    if (goodTrade) return goodTrade;
    if (leaderOk) return enemy.leader;
    // リーダーを狙えない（守護など）なら倒せる相手 → 一番脅威の相手
    const killable = foes.filter((d) => power >= d.hp).sort((a, b) => Rules.attackOf(game, b) - Rules.attackOf(game, a))[0];
    return killable || foes.sort((a, b) => Rules.attackOf(game, b) - Rules.attackOf(game, a))[0] || null;
}

async function runCpu(game, cpu, enemy) {
    // カードを出す（コストの高い順）
    for (let i = 0; i < 10; i++) {
        if (Rules.winner(game)) return;
        // hard はコストの高い順、normal は手札の順に出す
        const playable = cpu.hand.filter((c) => Rules.canPlay(game, cpu, c));
        if (aiDifficulty() === "hard") playable.sort((a, b) => Rules.costOf(game, cpu, b) - Rules.costOf(game, cpu, a));
        if (!playable.length) break;
        const card = playable[0];
        const opts = {};
        if (card.choices) opts.choice = card.choices.includes("破壊") ? (enemy.field.length ? "破壊" : "回復") : Fx.randomOf(card.choices);
        if (card.target && opts.choice !== "回復") opts.target = cpuPickTarget(card.target, card.targetFilter, game, cpu, enemy, null);

        UI.detailPinned = false;
        showDetail(card);
        UI.detailPinned = true;
        await sleep(800);
        Rules.playCard(game, cpu, card, opts);
        GothicSoundManager.playCard();
        UI.detailPinned = false;
        hideDetail();
        render();
        await sleep(450);
    }

    // 進化（normal は6割の確率。相手リーダーの体力が10以下なら必ず）
    const ev = cpu.field.filter((c) => Rules.canEvolve(cpu, c)).sort((a, b) => b.attack - a.attack)[0];
    const wantEvolve = aiDifficulty() === "hard" || Math.random() < 0.6 || enemy.leader.hp <= 10;
    if (ev && wantEvolve && !Rules.winner(game)) {
        const target = ev.evolveTarget ? cpuPickTarget(ev.evolveTarget, null, game, cpu, enemy, ev) : undefined;
        UI.flashUid = ev.uid;
        Rules.evolve(game, cpu, ev, { target });
        addLog(`相手の ${ev.name} が進化`);
        render();
        UI.flashUid = null;
        await sleep(700);
    }

    // 攻撃
    for (const atk of [...cpu.field]) {
        let guard = 0;
        while (guard++ < 4 && !Rules.winner(game) && Fx.onField(cpu, atk) && Rules.canAttack(atk)) {
            const target = cpuChooseAttack(game, atk, cpu, enemy);
            if (!target) break;
            await animateAttack(atk, target);
            GothicSoundManager.playAttack();
            addLog(`相手の ${atk.name} → ${target.isLeader ? "あなた" : target.name}`);
            Rules.attack(game, atk, target);
            render();
            await sleep(480);
        }
    }
}

// ----- デッキ（サーバーから取得するまでの仮） -----
function buildDeck(cls) {
    const pool = CARD_DATABASE.filter((c) => canAddToDeck(cls, c.id) && c.implemented !== false);
    const low = pool.filter((c) => c.cost <= 3);
    const mid = pool.filter((c) => c.cost >= 4 && c.cost <= 6);
    const high = pool.filter((c) => c.cost >= 7);
    return [
        ...Fx.pickRandom(low, 18),
        ...Fx.pickRandom(mid, 16),
        ...Fx.pickRandom(high, 6),
    ].map((c) => c.id);
}

const CLASS_KEY = {
    [CLASS.NOBLE]: "noble", [CLASS.MONSTER]: "monster", [CLASS.GHOST]: "ghost", [CLASS.WITCH]: "witch",
    [CLASS.PUPPET]: "doll", [CLASS.HUNTER]: "hunter", [CLASS.PIRATE]: "pirate",
};

// デッキ編成画面で保存したデッキを読む（userDecksList / activeDeckIndex）
// 戻り値: { name, cls, ids } / 読めない・40枚でない場合は { error }
function loadUserDeck() {
    const saved = localStorage.getItem("userDecksList");
    const activeIdx = parseInt(localStorage.getItem("activeDeckIndex") || "0", 10);
    if (!saved) return { error: "デッキが保存されていません" };

    let decks;
    try {
        decks = JSON.parse(saved);
    } catch (e) {
        return { error: "デッキの読み込みに失敗しました" };
    }
    let deck = decks[activeIdx];
    if (!deck || !deck.cards || deck.cards.length === 0) deck = decks.find((d) => d && d.cards && d.cards.length > 0);
    if (!deck) return { error: "デッキが保存されていません" };

    // 保存されているカードを cards.js のカードIDに変換（id があれば id、なければ名前で探す）
    const ids = [];
    const missing = [];
    for (const c of deck.cards) {
        const data = (c.id != null && CARD_MAP.get(Number(c.id))) || CARD_DATABASE.find((d) => d.name === c.name);
        const count = Number(c.count) || 1;
        if (!data) {
            missing.push(c.name);
            continue;
        }
        for (let i = 0; i < count; i++) ids.push(data.id);
    }
    if (missing.length) console.warn("cards.js に見つからないカード:", missing);

    // クラス: 無所属以外で最初に見つかったカードのクラス
    const first = ids.map((id) => CARD_MAP.get(id)).find((c) => c.class !== CLASS.NEUTRAL);
    const cls = first ? first.class : CLASS.NOBLE;
    const name = deck.name || `デッキ ${activeIdx + 1}`;

    if (ids.length !== 40) {
        return { error: `デッキ枚数が 40 枚ではありません（現在 ${ids.length} 枚${missing.length ? `、見つからないカード ${missing.length} 種` : ""}）` };
    }
    return { name, cls, ids };
}

function startSolo() {
    const params = new URLSearchParams(location.search);
    const classes = [CLASS.NOBLE, CLASS.MONSTER, CLASS.GHOST, CLASS.WITCH, CLASS.PUPPET, CLASS.HUNTER, CLASS.PIRATE];
    const conf = window.BATTLE_CONFIG || {};

    // 自分のデッキ: BATTLE_CONFIG → ?class=（動作確認用のランダムデッキ）→ 保存デッキ の順
    let myDeck;
    if (conf.deck) {
        myDeck = { name: conf.deckName || "デッキ", cls: conf.deckClass || CLASS.NOBLE, ids: conf.deck };
    } else if (classes.includes(params.get("class"))) {
        const cls = params.get("class");
        myDeck = { name: `${cls}（お試し）`, cls, ids: buildDeck(cls) };
    } else {
        myDeck = loadUserDeck();
        if (myDeck.error) {
            alert(`${myDeck.error}。デッキ編成画面に戻ります。`);
            location.href = "deck.html";
            return;
        }
    }
    $("deck-name").textContent = `デッキ: ${myDeck.name} (${myDeck.ids.length}枚)`;
    UI.deckClassKey = CLASS_KEY[myDeck.cls] || "noble";

    const cpuClass = classes.includes(params.get("cpu")) ? params.get("cpu") : classes[Math.floor(Math.random() * classes.length)];
    const game = Rules.startSolo({
        me: { id: 1, name: conf.myName || "あなた", deck: myDeck.ids },
        cpu: { id: 2, name: "CPU", deck: conf.cpuDeck || buildDeck(cpuClass) },
        reveal: (viewer, cards) => reveal(viewer, cards),
        log: (msg) => addLog(msg),
    });
    const me = game.players.find((p) => p.id === 1);
    const cpu = game.players.find((p) => p.id === 2);
    me.deckClass = myDeck.cls;
    cpu.deckClass = cpuClass;

    const ctrl = new SoloController(game, me, cpu);
    BattleUI.attach(ctrl);
    addLog("バトルが開始しました");

    (async () => {
        ctrl.busy = true;
        render();
        if (game.current === cpu) {
            await banner("後攻");
            await runCpu(game, cpu, me);
            if (checkEnd()) return;
            Rules.endTurn(game, cpu);
            Rules.startTurn(game, me);
            render();
            await banner("YOUR TURN");
        } else {
            await banner("先攻　YOUR TURN");
        }
        ctrl.busy = false;
        render();
    })();
}

// ===================================================================
// 初期化
// ===================================================================
document.addEventListener("DOMContentLoaded", () => {
    const board = $("board");
    board.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    board.addEventListener("click", onClick);
    board.addEventListener("pointerover", onPointerOver);
    board.addEventListener("pointerout", onPointerOut);
    $("end-turn").addEventListener("click", () => {
        if (UI.ctrl && UI.ctrl.canAct()) {
            UI.selectedUid = null;
            UI.ctrl.endTurn();
            render();
        }
    });
    $("target-cancel").addEventListener("click", () => endTargeting(undefined));
    $("btn-retry").addEventListener("click", () => location.reload());
    $("btn-home").addEventListener("click", () => { location.href = "profile.html"; });
    window.addEventListener("resize", () => render());

    if (document.body.dataset.mode !== "rank") startSolo();
});