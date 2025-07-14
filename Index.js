// index.js
require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const bot = new Telegraf(process.env.BOT_TOKEN);

const OWNER_ID = process.env.OWNER_ID;
const GROUP_ID = process.env.GROUP_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

const sessions = new Map();
const activeDeals = new Map();
const pendingCaptcha = new Map();
const adminList = new Set([OWNER_ID]);
let dealCounter = 1;

const releaseConfirm = new Map();
const refundConfirm = new Map();
const adminClaimed = new Map();
const upiStore = new Map();
const dealStats = {};

bot.use(async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  const userId = ctx.from.id;
  if (pendingCaptcha.has(userId)) return;

  const captcha = Math.floor(1000 + Math.random() * 9000);
  pendingCaptcha.set(userId, captcha);
  await ctx.reply(`🔐 Captcha Verification: Type *${captcha}* to continue`, { parse_mode: "Markdown" });

  bot.on("text", async (captchaCtx) => {
    if (captchaCtx.from.id !== userId) return;
    if (captchaCtx.message.text.trim() === captcha.toString()) {
      pendingCaptcha.delete(userId);
      await captchaCtx.reply("✅ Captcha verified!");
      return next();
    } else {
      await captchaCtx.reply("❌ Incorrect captcha. Try again later.");
    }
  });
});

bot.start((ctx) => {
  ctx.reply("👋 Welcome to Escrow Express!\nSelect deal type:", Markup.keyboard([['💸 INR Deal']]).oneTime().resize());
});

bot.hears('💸 INR Deal', async (ctx) => {
  sessions.set(ctx.from.id, { step: 1, deal: {} });
  await ctx.reply("📝 Please fill the following:");
  await ctx.reply("📌 Deal Of:");
});

bot.on("text", async (ctx) => {
  const session = sessions.get(ctx.from.id);
  if (!session) return;

  const step = session.step;
  const deal = session.deal;
  const input = ctx.message.text;

  switch (step) {
    case 1:
      deal.title = input;
      session.step++;
      return ctx.reply("💰 Total Amount:");
    case 2:
      deal.amount = input;
      session.step++;
      return ctx.reply("⏳ Time to complete deal:");
    case 3:
      deal.time = input;
      session.step++;
      return ctx.reply("🏦 Payment from which bank (Compulsory):");
    case 4:
      deal.bank = input;
      session.step++;
      return ctx.reply("🧾 Seller Username:");
    case 5:
      deal.seller = input;
      session.step++;
      return ctx.reply("🧾 Buyer Username:");
    case 6:
      deal.buyer = input;
      sessions.delete(ctx.from.id);

      const dealId = `DEAL${dealCounter++}`;
      deal.id = dealId;
      deal.status = "waiting_confirmation";
      deal.createdAt = Date.now();
      deal.confirm = { seller: false, buyer: false };
      activeDeals.set(dealId, deal);

      const msg = `✅ *New Deal Created*\n\n🆔 Deal ID: ${dealId}\n📌 Deal: ${deal.title}\n💰 Amount: ₹${deal.amount}\n⏳ Time: ${deal.time}\n🏦 Bank: ${deal.bank}\n👤 Seller: @${deal.seller}\n👤 Buyer: @${deal.buyer}`;

      await bot.telegram.sendMessage(GROUP_ID, msg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Seller Confirm", callback_data: `confirm_seller_${dealId}` },
            { text: "✅ Buyer Confirm", callback_data: `confirm_buyer_${dealId}` }
          ]]
        }
      });

      await bot.telegram.sendMessage(LOG_CHANNEL_ID, `📥 New deal logged: ${dealId}`);
      await ctx.reply("✅ Deal sent for confirmation in group.");
      break;
  }
});

bot.on("callback_query", async (ctx) => {
  const [action, role, dealId] = ctx.callbackQuery.data.split("_");
  const deal = activeDeals.get(dealId);
  if (!deal) return ctx.answerCbQuery("❌ Deal not found.");

  const user = ctx.from.username;
  if ((role === "seller" && user !== deal.seller) || (role === "buyer" && user !== deal.buyer)) {
    return ctx.answerCbQuery("⛔ Only assigned party can confirm.");
  }

  deal.confirm[role] = true;
  await ctx.answerCbQuery("✅ Confirmation received.");

  if (deal.confirm.seller && deal.confirm.buyer) {
    deal.status = "awaiting_payment";
    await bot.telegram.sendMessage(GROUP_ID, `📌 Deal *${dealId}* confirmed by both parties.`, { parse_mode: "Markdown" });
    await bot.telegram.sendMessage(`@${deal.buyer}`, `💳 Please send payment and reply with *Done Payment DEAL123 + Screenshot + Code*`, { parse_mode: "Markdown" });
    await bot.telegram.sendMessage(OWNER_ID, `🛎️ New deal *${dealId}* ready. Use /claim ${dealId} to claim.`);
  } else {
    await bot.telegram.sendMessage(GROUP_ID, `⏳ Waiting for ${deal.confirm.seller ? 'buyer' : 'seller'} to confirm ${dealId}.`, { parse_mode: "Markdown" });
  }
});

bot.command("claim", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const dealId = parts[1];
  const deal = activeDeals.get(dealId);
  if (!deal) return ctx.reply("❌ No such deal");
  adminClaimed.set(dealId, ctx.from.id);
  return ctx.reply(`✅ You have claimed ${dealId}`);
});

bot.command("release", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const dealId = parts[1];
  const deal = activeDeals.get(dealId);
  if (!deal || deal.status !== "payment_received") return ctx.reply("❌ Deal not eligible for release");
  const user = ctx.from.username;
  if (user !== deal.buyer && user !== deal.seller) return ctx.reply("⛔ Only buyer/seller can vote to release");

  if (!releaseConfirm.has(dealId)) releaseConfirm.set(dealId, new Set());
  releaseConfirm.get(dealId).add(user);

  if (releaseConfirm.get(dealId).size === 2) {
    await ctx.reply("✅ Both parties confirmed. Releasing payment.");
    await bot.telegram.sendMessage(GROUP_ID, `✅ Payment released for *${dealId}*`, { parse_mode: "Markdown" });
    deal.status = "released";
  } else {
    ctx.reply("⏳ Waiting for the other party to confirm release");
  }
});

bot.command("refund", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const dealId = parts[1];
  const deal = activeDeals.get(dealId);
  if (!deal || deal.status !== "payment_received") return ctx.reply("❌ Deal not eligible for refund");
  const user = ctx.from.username;
  if (user !== deal.buyer && user !== deal.seller) return ctx.reply("⛔ Only buyer/seller can vote to refund");

  if (!refundConfirm.has(dealId)) refundConfirm.set(dealId, new Set());
  refundConfirm.get(dealId).add(user);

  if (refundConfirm.get(dealId).size === 2) {
    await ctx.reply("✅ Both parties agreed. Refunding payment.");
    await bot.telegram.sendMessage(GROUP_ID, `❌ Payment refunded for *${dealId}*`, { parse_mode: "Markdown" });
    deal.status = "refunded";
  } else {
    ctx.reply("⏳ Waiting for other party to confirm refund");
  }
});

bot.command("mydeals", (ctx) => {
  const user = ctx.from.username;
  const deals = [...activeDeals.values()].filter(d => d.buyer === user || d.seller === user);
  if (deals.length === 0) return ctx.reply("❌ No deals found.");
  for (const d of deals) ctx.reply(`🆔 ${d.id} | 💰 ₹${d.amount} | 📌 ${d.status}`);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, deal] of activeDeals.entries()) {
    if (deal.status === "waiting_confirmation" && now - deal.createdAt > 3600000) {
      activeDeals.delete(id);
      bot.telegram.sendMessage(GROUP_ID, `❌ Deal *${id}* expired due to no confirmation.`, { parse_mode: "Markdown" });
    }
  }
}, 60000);

bot.launch();
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
