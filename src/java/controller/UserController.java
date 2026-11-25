package com.example.cardgame.controller;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.example.cardgame.model.RankGroup;
import com.example.cardgame.model.User;
import com.example.cardgame.repository.UserRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * ユーザー情報・ゲーム進行の保存 API
 *   GET /api/users/{id}           … ユーザー情報（進行データ・ランク込み）
 *   PUT /api/users/{id}/progress  … 進行データ（localStorage の中身）を保存
 *   PUT /api/users/{id}/name      … ユーザー名の変更（重複チェックあり）
 */
@RestController
@RequestMapping("/api/users")
@CrossOrigin(origins = "*")
public class UserController {

    private static final int MAX_PROGRESS_LENGTH = 500_000; // 進行データの上限（約500KB）

    private final UserRepository userRepository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public UserController(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable Long id) {
        return userRepository.findById(id)
                .<ResponseEntity<?>>map(u -> ResponseEntity.ok(Map.of(
                        "user", u,
                        "rank", RankGroup.getRankByMp(u.getMp()).getDisplayName())))
                .orElseGet(() -> notFound());
    }

    @PutMapping("/{id}/progress")
    public ResponseEntity<?> saveProgress(@PathVariable Long id, @RequestBody String body) {
        User user = userRepository.findById(id).orElse(null);
        if (user == null) return notFound();
        if (body == null || body.length() > MAX_PROGRESS_LENGTH) {
            return ResponseEntity.badRequest().body(Map.of("message", "保存データが大きすぎます。"));
        }

        JsonNode root;
        try {
            root = objectMapper.readTree(body);
        } catch (Exception e) {
            return ResponseEntity.badRequest().body(Map.of("message", "保存データの形式が正しくありません。"));
        }
        if (root == null || !root.isObject()) {
            return ResponseEntity.badRequest().body(Map.of("message", "保存データの形式が正しくありません。"));
        }

        // 一覧表示やランク判定に使う値は列にも入れておく
        JsonNode u = root.path("user");
        if (u.isObject()) {
            user.setMp(Math.max(0, u.path("mp").asInt(user.getMp())));
            user.setWins(Math.max(user.getWins(), u.path("wins").asInt(0)));
            user.setLosses(Math.max(user.getLosses(), u.path("losses").asInt(0)));
        }
        user.setProgress(body);
        userRepository.save(user);
        return ResponseEntity.ok(Map.of("message", "保存しました"));
    }

    @PutMapping("/{id}/name")
    public ResponseEntity<?> rename(@PathVariable Long id, @RequestBody Map<String, String> request) {
        User user = userRepository.findById(id).orElse(null);
        if (user == null) return notFound();

        String name = request.get("username");
        name = name == null ? "" : name.trim();
        if (name.isEmpty() || name.length() > 20) {
            return ResponseEntity.badRequest().body(Map.of("message", "名前は1〜20文字で入力してください。"));
        }
        if (!name.equals(user.getUsername()) && userRepository.existsByUsername(name)) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("message", "その名前は既に使われています。"));
        }

        user.setUsername(name);
        userRepository.save(user);
        return ResponseEntity.ok(Map.of("message", "名前を変更しました", "user", user));
    }

    private ResponseEntity<?> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("message", "ユーザーが見つかりません。"));
    }
}
