// js/rank-match.js
// rank_match.html で、WebSocket（STOMP）と MatchClient をつなぐ部分
// 読み込み順: stomp.umd.min.js → effects.js → cards.js → match.js → rank-match.js
//
// <script src="https://cdn.jsdelivr.net/npm/@stomp/stompjs@7/bundles/stomp.umd.min.js"></script>

const RankMatch = {
    stomp: null,
    client: null,   // MatchClient
    roomSub: null,

    // me: { id, name }、deck: [カードID...]（40枚）
    // ui: { onWaiting, onStart(client), onUpdate(game), onGameOver(winner, game, isWin), onDesync(), reveal(viewer, cards) }
    start(me, deck, ui) {
        const protocol = location.protocol === "https:" ? "wss" : "ws";
        this.stomp = new StompJs.Client({
            brokerURL: `${protocol}://${location.host}/ws`, // WebSocketConfig のエンドポイントに合わせる
            reconnectDelay: 0,
        });

        this.stomp.onConnect = () => {
            // マッチ成立の通知を待つ
            this.stomp.subscribe(`/topic/match/${me.id}`, frame => {
                const msg = JSON.parse(frame.body);
                if (msg.type === "START") this._onStart(me, msg, ui);
            });
            this.stomp.publish({
                destination: "/app/match/join",
                body: JSON.stringify({ userId: me.id, name: me.name, deck }),
            });
            ui.onWaiting && ui.onWaiting();
        };
        this.stomp.activate();
    },

    cancel(me) {
        if (!this.stomp) return;
        this.stomp.publish({ destination: "/app/match/cancel", body: JSON.stringify({ userId: me.id }) });
        this.stomp.deactivate();
    },

    _onStart(me, msg, ui) {
        const roomId = msg.roomId;

        this.client = new MatchClient({
            seed: msg.seed,
            players: msg.players,
            myId: me.id,
            send: action => this.stomp.publish({
                destination: `/app/room/${roomId}/action`,
                body: JSON.stringify(action),
            }),
            onUpdate: game => ui.onUpdate && ui.onUpdate(game),
            onGameOver: (winner, game) => {
                // 両者が勝敗を報告し、一致したらサーバーが記録する
                this.stomp.publish({
                    destination: `/app/room/${roomId}/result`,
                    body: JSON.stringify({ by: me.id, winnerId: winner.id }),
                });
                ui.onGameOver && ui.onGameOver(winner, game, winner.id === me.id);
            },
            onDesync: info => {
                console.error("盤面のズレを検知", info);
                ui.onDesync && ui.onDesync(info);
            },
            reveal: ui.reveal,
        });

        // 操作を受け取ったら MatchClient に渡す（自分の操作もここで戻ってくる）
        this.roomSub = this.stomp.subscribe(`/topic/room/${roomId}`, frame => {
            this.client.receive(JSON.parse(frame.body));
        });

        ui.onStart && ui.onStart(this.client);
        ui.onUpdate && ui.onUpdate(this.client.game);
    },
};

/*
===== rank_match.html での使い方の例 =====
RankMatch.start({ id: 1, name: "介人" }, myDeckIds, {
    onWaiting: () => showMessage("対戦相手を探しています…"),
    onStart: client => { window.match = client; },
    onUpdate: game => render(game),          // 盤面を描き直す
    onGameOver: (winner, game, isWin) => showResult(isWin),
    onDesync: () => showMessage("通信エラーが発生しました"),
    reveal: (viewer, cards) => showPeek(cards), // 「相手の手札を見る」効果の表示
});

// ボタン操作などから
match.play(card, { target });       // カードを出す
match.attack(attacker, defender);    // 攻撃（defender は相手カードか match.opponent.leader）
match.evolve(card, { target });      // 進化
match.endTurn();                     // ターン終了
match.canAct();                      // 今操作できるか（ボタンの有効・無効に使う）
*/