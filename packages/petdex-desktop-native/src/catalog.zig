//! The installed-pet catalog: the fixed table Settings lists and the
//! slug lookup both "pick this pet" entry points share.
//!
//! Extracted from main.zig (#613). Holds no effects and no model, so the
//! ceiling and the lookup can move without touching the app loop.

const std = @import("std");

// 32 silently truncated real installs: this machine had 47 pets across
// the two roots, so 15 of them never reached Settings. The ceiling is
// the thumbnail atlas, which registers as one image and has to fit the
// registry's 1MB slot: 96 cells of 48x52 is 0.91MB, and 128 would be
// 1.22MB.
pub const max_catalog = 96;
pub const CatalogEntry = struct {
    name: [64]u8 = @splat(0),
    len: usize = 0,
    root: [160]u8 = @splat(0),
    root_len: usize = 0,

    pub fn slice(self: *const CatalogEntry) []const u8 {
        return self.name[0..self.len];
    }
    pub fn rootSlice(self: *const CatalogEntry) []const u8 {
        return self.root[0..self.root_len];
    }
};
pub var catalog: [max_catalog]CatalogEntry = @splat(.{});
pub var catalog_len: usize = 0;

/// Slug to catalog index, the lookup both entry points into "pick this
/// pet" share: boot resolution (env/settings) and the petdex:// deep
/// link. Null means not installed, which each caller answers
/// differently — boot falls back to the first pet, a deep link ignores
/// the URL.
pub fn catalogIndexOf(slug: []const u8) ?usize {
    if (slug.len == 0) return null;
    for (catalog[0..catalog_len], 0..) |*entry, i| {
        if (std.mem.eql(u8, entry.slice(), slug)) return i;
    }
    return null;
}
