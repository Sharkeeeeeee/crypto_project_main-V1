/**
 * IronShield Discord Remote Controller (The Oracle - Module 4b)
 * Allows remote control of the engine via Discord Bot Commands
 */
import { Client, GatewayIntentBits, Message, TextChannel } from "discord.js";
import { createModuleLogger } from "./logger";

const log = createModuleLogger("DC_BOT");

export class DiscordController {
  private client: Client;
  private token: string;
  private adminId: string;
  private onStart: () => void;
  private onStop: () => void;
  private getStatus: () => string;

  constructor(
    token: string,
    adminId: string,
    callbacks: {
      onStart: () => void;
      onStop: () => void;
      getStatus: () => string;
    }
  ) {
    this.token = token;
    this.adminId = adminId;
    this.onStart = callbacks.onStart;
    this.onStop = callbacks.onStop;
    this.getStatus = callbacks.getStatus;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async initialize(): Promise<void> {
    if (!this.token) {
      log.warn("⚠️ No DISCORD_BOT_TOKEN provided. Remote control disabled.");
      return;
    }

    this.client.on("ready", () => {
      log.info(`🤖 Discord Bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on("messageCreate", async (message: Message) => {
      // Ignore bots
      if (message.author.bot) return;

      log.debug(`Received message from ${message.author.tag} (ID: ${message.author.id}): "${message.content}"`);

      // Simple security check (optional but recommended)
      if (this.adminId && message.author.id !== this.adminId) {
        log.warn(`Unauthorized command attempt from ${message.author.tag} (ID: ${message.author.id})`);
        return;
      }

      const content = message.content.toLowerCase().trim();

      if (content === "!start") {
        await message.reply("🛡️ **IronShield: Starting engine...**");
        this.onStart();
      } else if (content === "!stop") {
        await message.reply("🛑 **IronShield: Stopping engine...**");
        this.onStop();
      } else if (content === "!status") {
        const status = this.getStatus();
        await message.reply(`📊 **IronShield Current Status:**\n${status}`);
      } else if (content === "!help") {
        await message.reply(
          "📜 **IronShield Commands:**\n" +
          "`!start` - Start the scanning engine\n" +
          "`!stop`  - Emergency stop engine\n" +
          "`!status`- Show current performance & profit\n" +
          "`!help`  - Show this message"
        );
      }
    });

    try {
      await this.client.login(this.token);
    } catch (error: any) {
      log.error(`Discord login failed: ${error.message}`);
    }
  }

  async sendNotification(msg: string): Promise<void> {
    // Find the first available text channel the bot can speak in
    const channels = this.client.channels.cache.filter(c => c.isTextBased());
    const channel = channels.first() as TextChannel;
    if (channel) {
      await channel.send(msg);
    }
  }
}
