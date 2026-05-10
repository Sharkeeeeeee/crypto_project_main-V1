/**
 * IronShield Discord Notifier
 * Sends automated alerts for arbitrage events and system status
 */
import axios from "axios";
import { createModuleLogger } from "./logger";

const log = createModuleLogger("NOTIFIER");
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

export class Notifier {
  /**
   * Send a generic message to Discord
   */
  static async sendMessage(content: string, embed?: any) {
    if (!webhookUrl) return;

    try {
      await axios.post(webhookUrl, {
        content,
        embeds: embed ? [embed] : undefined,
      });
    } catch (error: any) {
      log.error(`Failed to send Discord notification: ${error.message}`);
    }
  }

  /**
   * Send notification for a successful arbitrage
   */
  static async notifyProfit(
    token: string,
    profitUSD: number,
    txHash: string,
    gasCostUSD: number
  ) {
    const embed = {
      title: "💰 Arbitrage Success!",
      color: 0x00ff00, // Green
      fields: [
        { name: "Token", value: token, inline: true },
        { name: "Net Profit", value: `$${profitUSD.toFixed(2)}`, inline: true },
        { name: "Gas Cost", value: `$${gasCostUSD.toFixed(2)}`, inline: true },
        { name: "Transaction", value: `[View on BaseScan](https://basescan.org/tx/${txHash})` },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "IronShield Engine v3.1" },
    };

    await this.sendMessage("", embed);
  }

  /**
   * Send notification for an execution failure
   */
  static async notifyFailure(txHash: string, error: string, profitUSD: number) {
    const embed = {
      title: "❌ Arbitrage Failed",
      color: 0xff0000, // Red
      fields: [
        { name: "Expected Profit", value: `$${profitUSD.toFixed(2)}`, inline: true },
        { name: "Error", value: error },
        { name: "Transaction", value: `[View on BaseScan](https://basescan.org/tx/${txHash})` },
      ],
      timestamp: new Date().toISOString(),
    };

    await this.sendMessage("", embed);
  }

  /**
   * Send notification for a high-profit opportunity found
   */
  static async notifyOpportunity(
    token: string,
    profitUSD: number,
    spread: number,
    pathDesc: string
  ) {
    const embed = {
      title: "🎯 High-Profit Opportunity Found!",
      color: 0xf1c40f, // Orange
      fields: [
        { name: "Token", value: token, inline: true },
        { name: "Est. Profit", value: `$${profitUSD.toFixed(2)}`, inline: true },
        { name: "Spread", value: `${spread.toFixed(2)}%`, inline: true },
        { name: "Route", value: pathDesc },
      ],
      timestamp: new Date().toISOString(),
    };

    await this.sendMessage("", embed);
  }

  /**
   * Send system status notification
   */
  static async notifySystem(status: string, details: string) {
    const embed = {
      title: "🛡️ IronShield System Alert",
      description: status,
      color: 0x3498db, // Blue
      fields: [{ name: "Details", value: details }],
      timestamp: new Date().toISOString(),
    };

    await this.sendMessage("", embed);
  }
}
