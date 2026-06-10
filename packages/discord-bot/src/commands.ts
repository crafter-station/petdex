// Slash command definitions for the Petdex bot. Kept as pure data so
// `register-commands.ts` can ship them to Discord and `bot.ts` can
// dispatch on `interaction.commandName` using the same source of truth.

import {
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";

const PETDEX_API_BASE = process.env.PETDEX_API_BASE ?? "https://petdex.dev";

export const commandData = [
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("Show the install command for a Petdex pet")
    .addStringOption((opt) =>
      opt
        .setName("slug")
        .setDescription("Pet slug, e.g. boba")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("featured")
    .setDescription("List the current featured collections"),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the top 5 creators on Petdex"),

  new SlashCommandBuilder()
    .setName("collection")
    .setDescription("Show pets in a featured collection")
    .addStringOption((opt) =>
      opt
        .setName("slug")
        .setDescription("Collection slug, e.g. graycraft, anime-heroes")
        .setRequired(true),
    ),
].map((c) => c.toJSON());

type Handler = (
  interaction: ChatInputCommandInteraction,
  client: Client,
) => Promise<void>;

export const handlers: Record<string, Handler> = {
  install: async (interaction) => {
    const slug = interaction.options.getString("slug", true).toLowerCase();
    const url = `${PETDEX_API_BASE}/api/manifest`;
    const res = await fetch(url);
    if (!res.ok) {
      await interaction.reply({
        content: `Could not reach Petdex (${res.status}). Try later.`,
        ephemeral: true,
      });
      return;
    }
    const data = (await res.json()) as {
      pets: Array<{ slug: string; displayName: string }>;
    };
    const pet = data.pets.find((p) => p.slug === slug);
    if (!pet) {
      await interaction.reply({
        content: `No pet with slug \`${slug}\`. Try \`/featured\` for ideas.`,
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(pet.displayName)
      .setURL(`${PETDEX_API_BASE}/pets/${pet.slug}`)
      .setColor(0x5266ea)
      .setDescription(`\`npx petdex install ${pet.slug}\``)
      .setImage(`${PETDEX_API_BASE}/pets/${pet.slug}/opengraph-image`);
    await interaction.reply({ embeds: [embed] });
  },

  featured: async (interaction) => {
    const res = await fetch(`${PETDEX_API_BASE}/api/manifest`);
    if (!res.ok) {
      await interaction.reply({
        content: `Could not reach Petdex (${res.status}).`,
        ephemeral: true,
      });
      return;
    }
    // The manifest doesn't expose collections yet — link the page until
    // /api/collections lands. Listing 10 names hard-coded is brittle.
    await interaction.reply({
      content:
        "Browse all featured collections at " +
        `${PETDEX_API_BASE}/collections — GRAYCRAFT, Anime Heroes, ` +
        "Cats Universe, Coders Club, and more.",
    });
  },

  leaderboard: async (interaction) => {
    await interaction.reply({
      content:
        `🏆 Top creators live at ${PETDEX_API_BASE}/leaderboard — ` +
        "ranks update as new pets are approved.",
    });
  },

  collection: async (interaction) => {
    const slug = interaction.options.getString("slug", true).toLowerCase();
    await interaction.reply({
      content: `Browse the **${slug}** collection at ${PETDEX_API_BASE}/collections/${slug}`,
    });
  },
};
