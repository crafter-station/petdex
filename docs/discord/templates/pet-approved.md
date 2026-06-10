# Template: pet approved → #showcase

The Petdex Bot uses this template when posting an approved pet. The
bot replaces the placeholders with values from the webhook payload.

---

🎉 **{{displayName}}** just landed on Petdex.

> {{description}}

Submitted by <@{{discordUserId}}> · catch them all at
https://petdex.dev/pets/{{slug}}

`npx petdex install {{slug}}`

---

**Embed**

- title: {{displayName}}
- description: first 200 chars of {{description}}
- url: https://petdex.dev/pets/{{slug}}
- image: https://petdex.dev/pets/{{slug}}/opengraph-image
- color: 0x5266EA
- fields:
  - name: kind, value: {{kind}}, inline: true
  - name: tags, value: first 4 tags joined by " · ", inline: true
  - name: install, value: `npx petdex install {{slug}}`, inline: false

If the submitter doesn't have a linked Discord account yet, drop the
`<@…>` mention and use their Petdex display name as plain text instead.
