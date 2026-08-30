const std = @import("std");
const builtin = @import("builtin");
const plat = @import("plat.zig");

pub const available = builtin.os.tag == .macos;
pub const issuer = "https://clerk.petdex.dev";
pub const client_id = "LcThwEayl6KAA1Qm";
pub const redirect_uri = "http://127.0.0.1:7777/callback";
pub const scopes = "profile email openid offline_access";
pub const library_url = "https://petdex.dev/api/desktop/library";
pub const service = "dev.petdex.desktop-native";
pub const account = "oauth";
pub const keychain_accounts = [_][]const u8{ "oauth-0", "oauth-1", "oauth-2", "oauth-3", "oauth-4" };
pub const max_pets = 64;

pub const Phase = enum { signed_out, loading, authorizing, exchanging, syncing, signed_in, failed, unavailable };
pub const PetStatus = enum { pending, approved, rejected, caught };
pub const LibraryView = enum { installed, yours, caught };

pub const Pet = struct {
    slug: [64]u8 = @splat(0),
    slug_len: usize = 0,
    display_name: [96]u8 = @splat(0),
    display_name_len: usize = 0,
    thumbnail_url: [512]u8 = @splat(0),
    thumbnail_url_len: usize = 0,
    status: PetStatus = .pending,

    pub fn slugSlice(self: *const Pet) []const u8 {
        return self.slug[0..self.slug_len];
    }

    pub fn displayName(self: *const Pet) []const u8 {
        return self.display_name[0..self.display_name_len];
    }

    pub fn thumbnailUrl(self: *const Pet) []const u8 {
        return self.thumbnail_url[0..self.thumbnail_url_len];
    }
};

pub const State = struct {
    phase: Phase = if (available) .signed_out else .unavailable,
    access_token: [8192]u8 = @splat(0),
    access_token_len: usize = 0,
    refresh_token: [8192]u8 = @splat(0),
    refresh_token_len: usize = 0,
    verifier: [86]u8 = @splat(0),
    verifier_len: usize = 0,
    oauth_state: [43]u8 = @splat(0),
    oauth_state_len: usize = 0,
    email: [160]u8 = @splat(0),
    email_len: usize = 0,
    name: [128]u8 = @splat(0),
    name_len: usize = 0,
    avatar_url: [1024]u8 = @splat(0),
    avatar_url_len: usize = 0,
    owned: [max_pets]Pet = @splat(.{}),
    owned_len: usize = 0,
    caught: [max_pets]Pet = @splat(.{}),
    caught_len: usize = 0,
    refreshing: bool = false,
    error_text: [192]u8 = @splat(0),
    error_len: usize = 0,

    pub fn accessToken(self: *const State) []const u8 {
        return self.access_token[0..self.access_token_len];
    }

    pub fn refreshToken(self: *const State) []const u8 {
        return self.refresh_token[0..self.refresh_token_len];
    }

    pub fn verifierSlice(self: *const State) []const u8 {
        return self.verifier[0..self.verifier_len];
    }

    pub fn oauthState(self: *const State) []const u8 {
        return self.oauth_state[0..self.oauth_state_len];
    }

    pub fn emailSlice(self: *const State) []const u8 {
        return self.email[0..self.email_len];
    }

    pub fn nameSlice(self: *const State) []const u8 {
        return self.name[0..self.name_len];
    }

    pub fn avatarUrl(self: *const State) []const u8 {
        return self.avatar_url[0..self.avatar_url_len];
    }

    pub fn errorSlice(self: *const State) []const u8 {
        return self.error_text[0..self.error_len];
    }

    pub fn setError(self: *State, text: []const u8) void {
        self.phase = .failed;
        self.error_len = @min(text.len, self.error_text.len);
        @memcpy(self.error_text[0..self.error_len], text[0..self.error_len]);
    }

    pub fn clearSession(self: *State) void {
        self.* = .{};
    }
};

const TokenResponse = struct {
    access_token: []const u8,
    refresh_token: ?[]const u8 = null,
};

const StoredTokens = struct {
    access_token: ?[]const u8 = null,
    refresh_token: ?[]const u8 = null,
};

const LibraryPet = struct {
    slug: []const u8,
    displayName: []const u8,
    status: []const u8,
    thumbnailUrl: ?[]const u8 = null,
};

const LibraryUser = struct {
    email: ?[]const u8 = null,
    username: ?[]const u8 = null,
    firstName: ?[]const u8 = null,
    lastName: ?[]const u8 = null,
    imageUrl: ?[]const u8 = null,
};

const LibraryResponse = struct {
    user: LibraryUser,
    owned: []const LibraryPet,
    caught: []const LibraryPet,
};

fn copyField(dest: []u8, len: *usize, value: []const u8) bool {
    if (value.len > dest.len) return false;
    @memcpy(dest[0..value.len], value);
    len.* = value.len;
    return true;
}

pub fn begin(state: *State, url_buf: []u8) ?[]const u8 {
    var verifier_raw: [64]u8 = undefined;
    var state_raw: [32]u8 = undefined;
    plat.fillRandom(&verifier_raw) catch return null;
    plat.fillRandom(&state_raw) catch return null;
    state.verifier_len = std.base64.url_safe_no_pad.Encoder.calcSize(verifier_raw.len);
    _ = std.base64.url_safe_no_pad.Encoder.encode(state.verifier[0..state.verifier_len], &verifier_raw);
    state.oauth_state_len = std.base64.url_safe_no_pad.Encoder.calcSize(state_raw.len);
    _ = std.base64.url_safe_no_pad.Encoder.encode(state.oauth_state[0..state.oauth_state_len], &state_raw);
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(state.verifierSlice(), &digest, .{});
    var challenge: [43]u8 = undefined;
    const encoded = std.base64.url_safe_no_pad.Encoder.encode(&challenge, &digest);
    const url = std.fmt.bufPrint(url_buf, "{s}/oauth/authorize?client_id={s}&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A7777%2Fcallback&scope=profile%20email%20openid%20offline_access&code_challenge={s}&code_challenge_method=S256&state={s}", .{ issuer, client_id, encoded, state.oauthState() }) catch return null;
    state.phase = .authorizing;
    state.error_len = 0;
    return url;
}

pub fn tokenBody(state: *const State, code: []const u8, out: []u8) ?[]const u8 {
    return std.fmt.bufPrint(out, "grant_type=authorization_code&client_id={s}&code={s}&code_verifier={s}&redirect_uri=http%3A%2F%2F127.0.0.1%3A7777%2Fcallback", .{ client_id, code, state.verifierSlice() }) catch null;
}

pub fn refreshBody(state: *const State, out: []u8) ?[]const u8 {
    return std.fmt.bufPrint(out, "grant_type=refresh_token&client_id={s}&refresh_token={s}&scope=profile%20email%20openid%20offline_access", .{ client_id, state.refreshToken() }) catch null;
}

pub fn applyTokenResponse(state: *State, allocator: std.mem.Allocator, body: []const u8) bool {
    var parsed = std.json.parseFromSlice(TokenResponse, allocator, body, .{ .ignore_unknown_fields = true }) catch return false;
    defer parsed.deinit();
    if (!copyField(&state.access_token, &state.access_token_len, parsed.value.access_token)) return false;
    if (parsed.value.refresh_token) |refresh| {
        if (!copyField(&state.refresh_token, &state.refresh_token_len, refresh)) return false;
    }
    return true;
}

pub fn applyStoredTokens(state: *State, allocator: std.mem.Allocator, body: []const u8) bool {
    const trimmed = std.mem.trim(u8, body, " \r\n");
    if (trimmed.len == 0) return false;
    if (trimmed[0] != '{') return copyField(&state.refresh_token, &state.refresh_token_len, trimmed);
    var parsed = std.json.parseFromSlice(StoredTokens, allocator, trimmed, .{ .ignore_unknown_fields = true }) catch return false;
    defer parsed.deinit();
    var restored = false;
    if (parsed.value.access_token) |access| {
        if (access.len > 0) {
            if (!copyField(&state.access_token, &state.access_token_len, access)) return false;
            restored = true;
        }
    }
    if (parsed.value.refresh_token) |refresh| {
        if (refresh.len > 0) {
            if (!copyField(&state.refresh_token, &state.refresh_token_len, refresh)) return false;
            restored = true;
        }
    }
    return restored;
}

pub fn keychainChunk(token: []const u8, index: usize) ?[]const u8 {
    if (token.len < keychain_accounts.len or index >= keychain_accounts.len) return null;
    const start = token.len * index / keychain_accounts.len;
    const end = token.len * (index + 1) / keychain_accounts.len;
    return token[start..end];
}

pub fn storedTokens(state: *const State, out: []u8) ?[]const u8 {
    if (state.access_token_len == 0 and state.refresh_token_len == 0) return null;
    return std.fmt.bufPrint(out, "{{\"access_token\":\"{s}\",\"refresh_token\":\"{s}\"}}", .{ state.accessToken(), state.refreshToken() }) catch null;
}

fn petStatus(value: []const u8) ?PetStatus {
    if (std.mem.eql(u8, value, "pending")) return .pending;
    if (std.mem.eql(u8, value, "approved")) return .approved;
    if (std.mem.eql(u8, value, "rejected")) return .rejected;
    if (std.mem.eql(u8, value, "caught")) return .caught;
    return null;
}

fn copyPets(dest: []Pet, source: []const LibraryPet) usize {
    var count: usize = 0;
    for (source[0..@min(source.len, dest.len)]) |item| {
        const status = petStatus(item.status) orelse continue;
        if (item.slug.len > dest[count].slug.len or item.displayName.len > dest[count].display_name.len) continue;
        @memcpy(dest[count].slug[0..item.slug.len], item.slug);
        dest[count].slug_len = item.slug.len;
        @memcpy(dest[count].display_name[0..item.displayName.len], item.displayName);
        dest[count].display_name_len = item.displayName.len;
        dest[count].status = status;
        if (item.thumbnailUrl) |url| {
            _ = copyField(&dest[count].thumbnail_url, &dest[count].thumbnail_url_len, url);
        }
        count += 1;
    }
    return count;
}

pub fn applyLibrary(state: *State, allocator: std.mem.Allocator, body: []const u8) bool {
    var parsed = std.json.parseFromSlice(LibraryResponse, allocator, body, .{ .ignore_unknown_fields = true }) catch return false;
    defer parsed.deinit();
    state.email_len = 0;
    state.name_len = 0;
    state.avatar_url_len = 0;
    if (parsed.value.user.email) |email| _ = copyField(&state.email, &state.email_len, email);
    if (parsed.value.user.imageUrl) |url| _ = copyField(&state.avatar_url, &state.avatar_url_len, url);
    if (parsed.value.user.username) |username| {
        _ = copyField(&state.name, &state.name_len, username);
    } else if (parsed.value.user.firstName) |first| {
        if (parsed.value.user.lastName) |last| {
            const written = std.fmt.bufPrint(&state.name, "{s} {s}", .{ first, last }) catch return false;
            state.name_len = written.len;
        } else {
            _ = copyField(&state.name, &state.name_len, first);
        }
    }
    state.owned_len = copyPets(&state.owned, parsed.value.owned);
    state.caught_len = copyPets(&state.caught, parsed.value.caught);
    state.phase = .signed_in;
    state.error_len = 0;
    return true;
}

test "PKCE authorization uses a fresh verifier and state" {
    var state: State = .{};
    var url: [1024]u8 = undefined;
    const value = begin(&state, &url).?;
    try std.testing.expectEqual(Phase.authorizing, state.phase);
    try std.testing.expectEqual(@as(usize, 86), state.verifier_len);
    try std.testing.expectEqual(@as(usize, 43), state.oauth_state_len);
    try std.testing.expect(std.mem.indexOf(u8, value, "code_challenge_method=S256") != null);
    try std.testing.expect(std.mem.indexOf(u8, value, state.oauthState()) != null);
}

test "library payload copies bounded user and pet data" {
    var state: State = .{};
    const body = "{\"user\":{\"email\":\"hi@petdex.dev\",\"username\":\"hunter\",\"imageUrl\":\"https://img.clerk.com/hunter.png\"},\"owned\":[{\"slug\":\"boba\",\"displayName\":\"Boba\",\"status\":\"approved\",\"thumbnailUrl\":\"https://assets.petdex.dev/pets/boba/thumb.webp\"}],\"caught\":[{\"slug\":\"droid\",\"displayName\":\"Droid\",\"status\":\"caught\"}]}";
    try std.testing.expect(applyLibrary(&state, std.testing.allocator, body));
    try std.testing.expectEqualStrings("hunter", state.nameSlice());
    try std.testing.expectEqualStrings("boba", state.owned[0].slugSlice());
    try std.testing.expectEqualStrings("https://assets.petdex.dev/pets/boba/thumb.webp", state.owned[0].thumbnailUrl());
    try std.testing.expectEqualStrings("https://img.clerk.com/hunter.png", state.avatarUrl());
    try std.testing.expectEqual(PetStatus.caught, state.caught[0].status);
}

test "Keychain payload persists available OAuth tokens" {
    var state: State = .{};
    const access = "access-token";
    const refresh = "refresh-token";
    @memcpy(state.access_token[0..access.len], access);
    state.access_token_len = access.len;
    @memcpy(state.refresh_token[0..refresh.len], refresh);
    state.refresh_token_len = refresh.len;
    var out: [256]u8 = undefined;
    try std.testing.expectEqualStrings("{\"access_token\":\"access-token\",\"refresh_token\":\"refresh-token\"}", storedTokens(&state, &out).?);

    var restored: State = .{};
    try std.testing.expect(applyStoredTokens(&restored, std.testing.allocator, storedTokens(&state, &out).?));
    try std.testing.expectEqualStrings(access, restored.accessToken());
    try std.testing.expectEqualStrings(refresh, restored.refreshToken());
}

test "Keychain payload persists access-only OAuth sessions" {
    var state: State = .{};
    const access = "access-token";
    @memcpy(state.access_token[0..access.len], access);
    state.access_token_len = access.len;
    var out: [128]u8 = undefined;
    const stored = storedTokens(&state, &out).?;
    var restored: State = .{};
    try std.testing.expect(applyStoredTokens(&restored, std.testing.allocator, stored));
    try std.testing.expectEqualStrings(access, restored.accessToken());
    try std.testing.expectEqual(@as(usize, 0), restored.refresh_token_len);
}

test "Keychain chunks reassemble the full refresh token" {
    const token = "abcdefghijklmnopqrstuvwxyz";
    var restored: [token.len]u8 = undefined;
    var offset: usize = 0;
    for (0..keychain_accounts.len) |index| {
        const chunk = keychainChunk(token, index).?;
        @memcpy(restored[offset..][0..chunk.len], chunk);
        offset += chunk.len;
    }
    try std.testing.expectEqualStrings(token, restored[0..offset]);

    var state: State = .{};
    try std.testing.expect(applyStoredTokens(&state, std.testing.allocator, &restored));
    try std.testing.expectEqualStrings(token, state.refreshToken());
}
