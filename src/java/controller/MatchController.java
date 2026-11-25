package com.example.cardgame.controller;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

import com.example.cardgame.model.MatchResult;
import com.example.cardgame.model.MatchRoom;
import com.example.cardgame.model.User;
import com.example.cardgame.repository.MatchResultRepository;
import com.example.cardgame.repository.UserRepository;
import com.example.cardgame.service.MatchService;

/**
 * ランクマッチの WebSocket（STOMP）窓口。
 * GameController（/join, /action）とは宛先が重ならないので共存できる。
 *
 * クライアント → サーバー（先頭の /app は WebSocketConfig の setApplicationDestinationPrefixes）
 *   /app/match/join            マッチング待ちに入る  { userId, deck: [カードID...] }
 *   /app/match/cancel          待ちをやめる          { userId }
 *   /app/room/{roomId}/action  対戦中の操作          { by, type, ... }
 *   /app/room/{roomId}/result  勝敗の報告            { by, winnerId }
 *
 * サーバー → クライアント
 *   /topic/match/{userId}      マッチ成立（START）   { type: "START", roomId, seed, players }
 *   /topic/room/{roomId}       操作の配信            { seq, by, type, ... }
 */
@Controller
public class MatchController {

    private static final int DECK_SIZE = 40;

    private final MatchService matchService;
    private final SimpMessagingTemplate messaging;
    private final UserRepository userRepository;
    private final MatchResultRepository matchResultRepository;

    public MatchController(MatchService matchService, SimpMessagingTemplate messaging,
            UserRepository userRepository, MatchResultRepository matchResultRepository) {
        this.matchService = matchService;
        this.messaging = messaging;
        this.userRepository = userRepository;
        this.matchResultRepository = matchResultRepository;
    }

    public record JoinRequest(long userId, List<Integer> deck) {}
    public record CancelRequest(long userId) {}
    public record ResultReport(long by, long winnerId) {}

    @MessageMapping("/match/join")
    public void join(@Payload JoinRequest req) {
        // 登録されているユーザーか確認し、表示名は DB のユーザー名を使う
        Optional<User> user = userRepository.findById(req.userId());
        if (user.isEmpty()) return;
        if (req.deck() == null || req.deck().size() != DECK_SIZE) return;

        MatchRoom.Entry entry = new MatchRoom.Entry(req.userId(), user.get().getUsername(), req.deck());
        MatchRoom room = matchService.join(entry);
        if (room == null) return; // 相手待ち

        Map<String, Object> start = new HashMap<>();
        start.put("type", "START");
        start.put("roomId", room.getRoomId());
        start.put("seed", room.getSeed());
        start.put("players", room.getPlayers()); // 先頭が先攻
        for (MatchRoom.Entry p : room.getPlayers()) {
            messaging.convertAndSend("/topic/match/" + p.id(), start);
        }
    }

    @MessageMapping("/match/cancel")
    public void cancel(@Payload CancelRequest req) {
        matchService.cancel(req.userId());
    }

    /** 操作に番号を付けて両者に配るだけ。中身の計算はしない */
    @MessageMapping("/room/{roomId}/action")
    public void action(@DestinationVariable String roomId, @Payload Map<String, Object> action) {
        MatchRoom room = matchService.getRoom(roomId);
        if (room == null || room.isFinished()) return;
        Object by = action.get("by");
        if (!(by instanceof Number n) || !room.hasPlayer(n.longValue())) return;

        action.put("seq", room.nextSeq());
        messaging.convertAndSend("/topic/room/" + roomId, action);
    }

    /** 両者の報告がそろって一致したら結果を保存する */
    @MessageMapping("/room/{roomId}/result")
    public void result(@DestinationVariable String roomId, @Payload ResultReport report) {
        MatchRoom room = matchService.getRoom(roomId);
        if (room == null || !room.hasPlayer(report.by())) return;

        Long winnerId = room.report(report.by(), report.winnerId());
        if (!room.isFinished()) return; // もう一方の報告待ち

        if (winnerId != null) {
            saveResult(room, winnerId);
        }
        // winnerId が null = 両者の報告が食い違った（盤面のズレ・不正の可能性）→ 記録しない
        matchService.closeRoom(roomId);
    }

    private void saveResult(MatchRoom room, long winnerId) {
        MatchRoom.Entry winner = room.getPlayer(winnerId);
        MatchRoom.Entry loser = room.getPlayers().stream().filter(p -> p.id() != winnerId).findFirst().orElse(null);
        if (winner == null || loser == null) return;

        // 対戦履歴（MatchResultRepository）に、両者それぞれの視点で1件ずつ残す
        String now = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
        matchResultRepository.save(new MatchResult(winner.name(), "WIN", loser.name(), now));
        matchResultRepository.save(new MatchResult(loser.name(), "LOSE", winner.name(), now));

        // DB の勝利数・敗北数を更新
        userRepository.findById(winner.id()).ifPresent(u -> {
            u.setWins(u.getWins() + 1);
            userRepository.save(u);
        });
        userRepository.findById(loser.id()).ifPresent(u -> {
            u.setLosses(u.getLosses() + 1);
            userRepository.save(u);
        });
    }
}
