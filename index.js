require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // PRIVILEGED — enable "Server Members Intent" in the Dev Portal
    GatewayIntentBits.GuildMessages // needed to live-track new reviews
  ]
});

// ───────────────────────────────────────────────
//  STATUS CONFIG  (channel name + look + message)
// ───────────────────────────────────────────────
const STATUS = {
  open: {
    channelName: '🟢・order-status',
    label: 'OPEN',
    emoji: '🟢',
    color: 0x2ecc71, // green
    blurb: 'We are now **accepting orders**! Come place yours. 🛒'
  },
  busy: {
    channelName: '🟡・order-status',
    label: 'BUSY',
    emoji: '🟡',
    color: 0xf1c40f, // yellow
    blurb: 'We are **swamped right now** — expect longer wait times. ⏳'
  },
  paused: {
    channelName: '🟠・order-status',
    label: 'PAUSED',
    emoji: '🟠',
    color: 0xe67e22, // orange
    blurb: 'Orders are **temporarily paused**. Back shortly. ⏸️'
  },
  closed: {
    channelName: '🔴・order-status',
    label: 'CLOSED',
    emoji: '🔴',
    color: 0xe74c3c, // red
    blurb: 'We are now **closed**. Check back later to order. 🔒'
  }
};

// ROLE ALLOWED TO CHANGE STATUS
const allowedRole = '1449172692820557825';
// ROLE TO PING ON STATUS CHANGE
const pingRole = '1449172692463915144';

// CHANNEL WHERE CUSTOMERS CAN LEAVE A REVIEW
const REVIEW_CHANNEL_ID = '1449172693353103367';

// Footer marker so we can recognise (and clean up) our own messages
const FOOTER_MARKER = 'Order Status System';

// ───────────────────────────────────────────────
//  STATS CONFIG  (live customer + review counter)
// ───────────────────────────────────────────────
const CUSTOMER_ROLE_ID = '1449172692463915145';
// Optional: set STATS_CHANNEL_ID in .env to use an existing channel.
// If left blank, the bot creates (and remembers) its own stats channel.
const STATS_CHANNEL_ID = process.env.STATS_CHANNEL_ID || null;
// Optional: set STATS_CATEGORY_ID in .env to a CATEGORY id so the auto-created
// stats channel is placed neatly inside that category instead of floating at
// the top of the server. Leave blank to keep the old behaviour.
const STATS_CATEGORY_ID = process.env.STATS_CATEGORY_ID || null;
const STATS_CHANNEL_NAME = '📊・live-stats';
// Hidden marker used to re-find our own stats channel/message even if
// state.json gets wiped — this is what prevents duplicate channels.
const STATS_CHANNEL_TOPIC = 'Live customer & review counts — auto-updated.';
const STATS_FOOTER = 'Auto-updates • Order System';
// Count only human (non-bot) messages in the review channel as "reviews".
const COUNT_ONLY_NONBOT_REVIEWS = true;
// How often to do a full, self-correcting recount (catches missed deletes).
const STATS_FULL_REFRESH_MS = 15 * 60 * 1000; // 15 min
// Debounce so a burst of joins/reviews collapses into one embed edit.
const STATS_EDIT_DEBOUNCE_MS = 4000;

// ───────────────────────────────────────────────
//  TICKET AUTO-MESSAGE CONFIG
// ───────────────────────────────────────────────
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || 'PUT_TICKET_CATEGORY_ID_HERE';
const TICKET_NAME_PREFIXES = ['ticket', 'order'];
const TICKET_GREETING_DELAY_MS = 2500;

// ───────────────────────────────────────────────
//  PAYMENT CONFIG
// ───────────────────────────────────────────────
const PAYPAL_LINK = 'https://paypal.me/MyDadsSoft';

// ───────────────────────────────────────────────
//  PERSISTED STATE
// ───────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

let state = {
  lastAnnouncementId: null, // ID of the last status embed we posted
  currentStatus: null, // 'open' | 'busy' | 'paused' | 'closed'
  updatedBy: null, // user ID who last set it
  updatedAt: null, // ISO timestamp
  statsChannelId: null, // remembered auto-created stats channel
  statsMessageId: null, // the embed we edit in place
  reviewCount: 0 // cached review total
};

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    state = { ...state, ...JSON.parse(raw) };
    console.log('💾  State loaded:', state);
  } catch {
    console.log('💾  No existing state file — starting fresh.');
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('⚠️  Could not persist state:', err.message);
  }
}

loadState();

// ───────────────────────────────────────────────
//  CHANNEL RENAME (rate-limit aware)
// ───────────────────────────────────────────────
let renameTimer = null;
let pendingRenameName = null;
const RENAME_DEBOUNCE_MS = 2000;

function queueChannelRename(channel, name) {
  if (!channel || !name) return;
  if (channel.name === name) return; // already correct — no API call

  pendingRenameName = name;
  if (renameTimer) clearTimeout(renameTimer);

  renameTimer = setTimeout(() => {
    renameTimer = null;
    const target = pendingRenameName;
    pendingRenameName = null;
    if (!target || channel.name === target) return;
    channel.setName(target).catch(err => {
      console.warn('⚠️  Channel rename delayed/failed (rate limit?):', err.message);
    });
  }, RENAME_DEBOUNCE_MS);
}

// ───────────────────────────────────────────────
//  STATS SYSTEM
// ───────────────────────────────────────────────

// Resolve the guild from the review channel (same server as the role).
async function getStatsGuild() {
  const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
  return reviewChannel ? reviewChannel.guild : null;
}

// Full count of reviews by paging through the channel history.
async function countReviews(channel) {
  let total = 0;
  let before;
  const MAX_PAGES = 300; // safety cap (~30k messages)
  for (let i = 0; i < MAX_PAGES; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    total += COUNT_ONLY_NONBOT_REVIEWS ? batch.filter(m => !m.author.bot).size : batch.size;
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return total;
}

function buildStatsEmbed(customers, reviews, guild) {
  return new EmbedBuilder()
    .setColor(0xffd700) // gold
    .setTitle('📊  LIVE STORE STATS')
    .setDescription('Real numbers, updated automatically. Thanks to everyone who’s ordered & reviewed. 🔥')
    .addFields(
      { name: '👥  Happy Customers', value: `\`\`\`\n${customers.toLocaleString()}\n\`\`\``, inline: true },
      { name: '⭐  Reviews', value: `\`\`\`\n${reviews.toLocaleString()}\n\`\`\``, inline: true }
    )
    .setThumbnail(guild?.iconURL({ size: 256 }) || null)
    .setFooter({ text: STATS_FOOTER })
    .setTimestamp();
}

// Move the stats channel into the configured category if it isn't already
// there (only acts when STATS_CATEGORY_ID is set). Keeps the channel's own
// permission overwrites instead of syncing to the category.
async function ensureInCategory(channel) {
  try {
    if (
      channel &&
      STATS_CATEGORY_ID &&
      typeof channel.setParent === 'function' &&
      channel.parentId !== STATS_CATEGORY_ID
    ) {
      await channel.setParent(STATS_CATEGORY_ID, { lockPermissions: false });
      console.log('📊  Moved stats channel into its category.');
    }
  } catch (err) {
    console.warn('⚠️  Could not move stats channel into category:', err.message);
  }
  return channel;
}

// Resolve the stats channel without ever creating a duplicate:
//   1. explicit .env channel        →  use it
//   2. the ID we saved last time     →  use it (deleted vs. transient aware)
//   3. an existing channel we made   →  adopt it (survives a wiped state.json)
//   4. nothing anywhere              →  create one
async function ensureStatsChannel(guild) {
  // 1. Explicit channel from .env always wins.
  if (STATS_CHANNEL_ID) {
    const c = await client.channels.fetch(STATS_CHANNEL_ID).catch(() => null);
    if (c) return await ensureInCategory(c);
  }

  // 2. The channel we remembered last time.
  if (state.statsChannelId) {
    try {
      const c = await client.channels.fetch(state.statsChannelId);
      if (c) return await ensureInCategory(c);
    } catch (err) {
      if (err?.code === 10003) {
        // 10003 = Unknown Channel → genuinely deleted, so forget it.
        state.statsChannelId = null;
        state.statsMessageId = null;
        saveState();
      } else {
        // Transient error (rate limit, blip, perms): do NOT create a
        // duplicate — skip this cycle and try again next time.
        console.warn('⚠️  Stats channel fetch failed (will retry):', err.message);
        return null;
      }
    }
  }

  // 3. No valid saved ID (e.g. state.json was wiped on restart).
  //    Re-find the channel we made before by its marker, BEFORE creating one.
  try {
    await guild.channels.fetch(); // ensure the channel cache is complete
  } catch {
    /* ignore — fall back to whatever is cached */
  }
  const existing = guild.channels.cache.find(
    ch =>
      ch.type === ChannelType.GuildText &&
      (ch.topic === STATS_CHANNEL_TOPIC || ch.name === STATS_CHANNEL_NAME)
  );
  if (existing) {
    state.statsChannelId = existing.id;
    state.statsMessageId = null; // embed gets re-adopted in refreshStats
    saveState();
    console.log('📊  Re-adopted existing stats channel:', existing.name);
    return await ensureInCategory(existing);
  }

  // 4. Nothing exists anywhere — create it.
  try {
    const created = await guild.channels.create({
      name: STATS_CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: STATS_CATEGORY_ID || undefined, // drop it in a category if one is set
      topic: STATS_CHANNEL_TOPIC,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions]
        }
      ]
    });
    state.statsChannelId = created.id;
    state.statsMessageId = null;
    saveState();
    console.log('📊  Created stats channel:', created.name);
    return created;
  } catch (err) {
    console.warn('⚠️  Could not create stats channel (need Manage Channels?):', err.message);
    return null;
  }
}

// Re-find our own stats embed in the channel, so a wiped state.json edits the
// existing message instead of posting a duplicate.
async function findExistingStatsMessage(channel) {
  try {
    const recent = await channel.messages.fetch({ limit: 25 });
    return (
      recent.find(
        m =>
          m.author.id === client.user.id &&
          m.embeds.some(e => e.footer && e.footer.text === STATS_FOOTER)
      ) || null
    );
  } catch {
    return null;
  }
}

// Recompute + render the stats embed. Pass { recountReviews:true } for a full sweep.
async function refreshStats({ recountReviews = false } = {}) {
  const guild = await getStatsGuild();
  if (!guild) return;

  if (recountReviews) {
    const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
    if (reviewChannel) {
      state.reviewCount = await countReviews(reviewChannel);
      saveState();
    }
  }

  const role = guild.roles.cache.get(CUSTOMER_ROLE_ID);
  const customers = role ? role.members.size : 0;
  const embed = buildStatsEmbed(customers, state.reviewCount || 0, guild);

  const statsChannel = await ensureStatsChannel(guild);
  if (!statsChannel) return;

  // Recover the embed message if we lost track of it (e.g. wiped state).
  if (!state.statsMessageId) {
    const existing = await findExistingStatsMessage(statsChannel);
    if (existing) {
      state.statsMessageId = existing.id;
      saveState();
    }
  }

  if (state.statsMessageId) {
    try {
      const msg = await statsChannel.messages.fetch(state.statsMessageId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch {
      /* message gone — fall through and repost */
    }
  }
  const sent = await statsChannel.send({ embeds: [embed] });
  state.statsMessageId = sent.id;
  saveState();
}

// Debounced trigger for live events (joins, role changes, new reviews).
let statsTimer = null;
function scheduleStatsRefresh(opts) {
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    statsTimer = null;
    refreshStats(opts).catch(err => console.error('Stats refresh failed:', err));
  }, STATS_EDIT_DEBOUNCE_MS);
}

// ───────────────────────────────────────────────
//  READY  (bound to both event names for version safety,
//  guarded so boot logic runs once.)
// ───────────────────────────────────────────────
let booted = false;

async function onReady() {
  if (booted) return;
  booted = true;

  console.log(`✅ ${client.user.tag} is online`);

  // Re-apply the order-status channel name to match persisted status.
  if (state.currentStatus && STATUS[state.currentStatus] && process.env.CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(process.env.CHANNEL_ID);
      if (channel) queueChannelRename(channel, STATUS[state.currentStatus].channelName);
    } catch (err) {
      console.warn('⚠️  Could not re-apply channel name on boot:', err.message);
    }
  }

  // Prime the customer cache (needs Server Members Intent).
  try {
    const guild = await getStatsGuild();
    if (guild) await guild.members.fetch();
  } catch (err) {
    console.warn(
      '⚠️  Could not fetch members — enable the "Server Members Intent" in the Dev Portal. Customer count will read 0 until then. (' +
        err.message +
        ')'
    );
  }

  // Initial stats render with a full review recount.
  await refreshStats({ recountReviews: true }).catch(err =>
    console.error('Initial stats render failed:', err)
  );

  // Periodic self-correcting refresh (catches missed deletes/edge cases).
  setInterval(() => {
    refreshStats({ recountReviews: true }).catch(() => {});
  }, STATS_FULL_REFRESH_MS);
}

client.once('clientReady', onReady);
client.once('ready', onReady);

// ───────────────────────────────────────────────
//  STATUS COMMAND HELPERS
// ───────────────────────────────────────────────
async function clearOldAnnouncements(channel) {
  if (state.lastAnnouncementId) {
    try {
      const old = await channel.messages.fetch(state.lastAnnouncementId);
      if (old) await old.delete();
    } catch {
      /* already gone — ignore */
    }
    state.lastAnnouncementId = null;
    saveState();
  }

  try {
    const recent = await channel.messages.fetch({ limit: 25 });
    const mine = recent.filter(
      m =>
        m.author.id === client.user.id &&
        m.embeds.some(e => e.footer && e.footer.text === FOOTER_MARKER)
    );
    for (const msg of mine.values()) {
      await msg.delete().catch(() => {});
    }
  } catch {
    /* ignore sweep errors */
  }
}

// ───────────────────────────────────────────────
//  INTERACTIONS (slash commands + buttons)
// ───────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  // ---- Payment buttons ----
  if (interaction.isButton()) {
    try {
      if (interaction.customId === 'pay_paypal') {
        const embed = new EmbedBuilder()
          .setColor(0x009cde) // PayPal blue
          .setTitle('💳  Pay with PayPal')
          .setDescription(
            `Please send your payment using the link below:\n\n**${PAYPAL_LINK}**\n\n` +
            '⚠️ **PayPal must be sent as Friends & Family (F&F) ONLY** — **no Goods & Services**.\n' +
            'Payments sent any other way may be refunded and your order delayed.\n\n' +
            'Once you’ve paid, drop a screenshot here so staff can confirm. ✅'
          )
          .setFooter({ text: 'Order System' });

        return await interaction.reply({ embeds: [embed] });
      }

      if (interaction.customId === 'pay_bank') {
        const embed = new EmbedBuilder()
          .setColor(0x2ecc71) // green
          .setTitle('🏦  Pay by Bank Transfer')
          .setDescription(
            'No problem! A staff member will send you the **bank details** here in this ticket shortly.\n\n' +
            'Please wait for those details before sending anything. ⏳'
          )
          .setFooter({ text: 'Order System' });

        return await interaction.reply({ embeds: [embed] });
      }
      return;
    } catch (err) {
      console.error('Error handling payment button:', err);
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  // ---- /currentstatus command (must be registered with Discord) ----
  if (interaction.commandName === 'currentstatus') {
    try {
      if (!state.currentStatus || !STATUS[state.currentStatus]) {
        return await interaction.reply({
          content: 'ℹ️ No status has been set yet.',
          flags: MessageFlags.Ephemeral
        });
      }
      const s = STATUS[state.currentStatus];
      const when = state.updatedAt
        ? `<t:${Math.floor(new Date(state.updatedAt).getTime() / 1000)}:R>`
        : 'unknown';
      const who = state.updatedBy ? `<@${state.updatedBy}>` : 'unknown';
      return await interaction.reply({
        content: `${s.emoji} Orders are currently **${s.label}** — set by ${who} (${when}).`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      });
    } catch (err) {
      console.error('Error handling /currentstatus:', err);
      return;
    }
  }

  // ---- /status command ----
  if (interaction.commandName !== 'status') return;

  try {
    if (!interaction.member.roles.cache.has(allowedRole)) {
      return await interaction.reply({
        content: '❌ You do not have permission to change the order status.',
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const type = interaction.options.getString('type');
    const status = STATUS[type];

    if (!status) {
      return await interaction.editReply({ content: '❌ Unknown status type.' });
    }

    let channel;
    try {
      channel = await client.channels.fetch(process.env.CHANNEL_ID);
    } catch {
      return await interaction.editReply({
        content: '❌ Channel not found. Check your CHANNEL_ID in .env'
      });
    }
    if (!channel) {
      return await interaction.editReply({
        content: '❌ Channel not found. Check your CHANNEL_ID in .env'
      });
    }

    const embed = new EmbedBuilder()
      .setColor(status.color)
      .setTitle(`${status.emoji}  ORDERS ARE ${status.label}`)
      .setDescription(status.blurb)
      .addFields(
        { name: 'Status', value: `**${status.label}**`, inline: true },
        { name: 'Updated by', value: `<@${interaction.user.id}>`, inline: true }
      )
      .setFooter({ text: FOOTER_MARKER })
      .setTimestamp();

    await clearOldAnnouncements(channel);

    const sent = await channel.send({
      content: `<@&${pingRole}>`,
      embeds: [embed],
      allowedMentions: { roles: [pingRole] }
    });

    state.lastAnnouncementId = sent.id;
    state.currentStatus = type;
    state.updatedBy = interaction.user.id;
    state.updatedAt = new Date().toISOString();
    saveState();

    await interaction.editReply({
      content: `✅ Status set to **${status.label}** and the team was notified.`
    });

    queueChannelRename(channel, status.channelName);
  } catch (error) {
    console.error('Error handling /status:', error);
    const msg = { content: '❌ Something went wrong.' };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ ...msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ───────────────────────────────────────────────
//  LIVE STATS EVENTS
// ───────────────────────────────────────────────

// New review posted → bump the count.
client.on('messageCreate', message => {
  if (message.channelId !== REVIEW_CHANNEL_ID) return;
  if (COUNT_ONLY_NONBOT_REVIEWS && message.author.bot) return;
  state.reviewCount = (state.reviewCount || 0) + 1;
  saveState();
  scheduleStatsRefresh();
});

// Review deleted → let the next full sweep correct the number.
client.on('messageDelete', message => {
  if (message.channelId !== REVIEW_CHANNEL_ID) return;
  scheduleStatsRefresh({ recountReviews: true });
});

// Customer role added/removed, or members joining/leaving → refresh count.
client.on('guildMemberUpdate', () => scheduleStatsRefresh());
client.on('guildMemberAdd', () => scheduleStatsRefresh());
client.on('guildMemberRemove', () => scheduleStatsRefresh());

// ───────────────────────────────────────────────
//  TICKET AUTO-GREETING  (works with Ticket Tool: channels OR threads)
// ───────────────────────────────────────────────
function looksLikeTicket(channel) {
  if (
    TICKET_CATEGORY_ID &&
    TICKET_CATEGORY_ID !== 'PUT_TICKET_CATEGORY_ID_HERE' &&
    channel.parentId === TICKET_CATEGORY_ID
  ) {
    return true;
  }
  const name = (channel.name || '').toLowerCase();
  return TICKET_NAME_PREFIXES.some(prefix => name.startsWith(prefix.toLowerCase()));
}

function findTicketOpener(channel) {
  try {
    const memberOverwrite = channel.permissionOverwrites?.cache?.find(
      ow => ow.type === OverwriteType.Member && ow.id !== client.user.id
    );
    if (memberOverwrite) return memberOverwrite.id;
  } catch {
    /* ignore */
  }
  return null;
}

async function sendTicketGreeting(channel) {
  const fresh = await channel.fetch().catch(() => channel);
  const openerId = findTicketOpener(fresh);
  const greetingTarget = openerId ? `<@${openerId}>` : 'there';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2) // Discord blurple
    .setTitle('🎫  Welcome — Let’s Get Your Order Started!')
    .setDescription(
      'Thanks for opening a ticket! To get things moving, please reply here with the details below. 👇'
    )
    .addFields(
      {
        name: '🛒  What would you like to order?',
        value:
          'Tell us exactly what you want — **Wheelspins**, **Credits**, or **Cars** ' +
          '(amount, which cars, any extras).'
      },
      {
        name: '🚫  What we don’t do',
        value:
          'We do **not** do **XP** or **Skill Points**. These have been **flagged by ' +
          'PGG / Playground Games** and carry a **high ban risk**, so we won’t touch them. ⛔'
      },
      {
        name: '🔐  Account info',
        value:
          'To complete your order we’ll need your **account login details**. ' +
          'Please send them **here in this ticket** once a staff member confirms they’re ready for you.\n' +
          '⚠️ Only ever share your info inside this ticket — never with anyone in DMs.'
      },
      {
        name: '💰  How would you like to pay?',
        value:
          'Pick an option below and we’ll sort the rest. 👇\n' +
          '⚠️ PayPal is **Friends & Family (F&F) only** — no Goods & Services.'
      },
      {
        name: '⭐  Happy with your order?',
        value: `Once everything’s done, we’d love a review! Drop one in <#${REVIEW_CHANNEL_ID}> 💛`
      }
    )
    .setFooter({ text: 'Order System' })
    .setTimestamp();

  const payRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pay_paypal')
      .setLabel('PayPal')
      .setEmoji('💳')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('pay_bank')
      .setLabel('Bank Transfer')
      .setEmoji('🏦')
      .setStyle(ButtonStyle.Secondary)
  );

  await fresh.send({
    content: openerId ? `${greetingTarget}` : undefined,
    embeds: [embed],
    components: [payRow],
    allowedMentions: openerId ? { users: [openerId] } : { parse: [] }
  });
}

// Channel-mode tickets
client.on('channelCreate', async channel => {
  try {
    if (channel.type !== ChannelType.GuildText) return;
    await new Promise(res => setTimeout(res, TICKET_GREETING_DELAY_MS));
    const fresh = await channel.fetch().catch(() => channel);
    if (!looksLikeTicket(fresh)) return;
    await sendTicketGreeting(fresh);
  } catch (error) {
    console.error('Error sending ticket greeting (channel):', error);
  }
});

// Thread-mode tickets
client.on('threadCreate', async thread => {
  try {
    if (!looksLikeTicket(thread)) return;
    await new Promise(res => setTimeout(res, TICKET_GREETING_DELAY_MS));
    await thread.join().catch(() => {});
    await sendTicketGreeting(thread);
  } catch (error) {
    console.error('Error sending ticket greeting (thread):', error);
  }
});

// ───────────────────────────────────────────────
//  CRASH SAFETY
// ───────────────────────────────────────────────
client.on('error', err => console.error('Client error:', err));
client.on('shardError', err => console.error('Shard error:', err));
process.on('unhandledRejection', err => console.error('Unhandled promise rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

client.login(process.env.TOKEN);