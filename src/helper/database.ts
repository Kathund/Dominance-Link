import { google } from 'googleapis';
import { schedule } from 'node-cron';
import Database from 'better-sqlite3';
import { getNetworth } from 'skyhelper-networth';
import { JWT } from 'google-auth-library';
import { Client, EmbedBuilder, Guild, Role } from 'discord.js';
import config from '../config.json' assert { type: 'json' };
import {
  uuidToName,
  skillAverage,
  uuidToDiscord,
  doubleDigits,
  abbreviateNumber,
  toCamelCase,
  rankTagF,
  formatDateForDb,
  getESTDate,
  updateTable
} from './utils.js';
import { bwPrestiges, duelsDivisionRoles, discordRoles, hypixelRoles } from './constants.js';
import { HypixelGuildMember, HypixelRoleKeys, StringObject } from '../types/global.d.js';
import { textChannels } from '../events/discord/ready.js';
import { chat } from '../handlers/workerHandler.js';
import { hypixel } from '../index.js';
import { archiveGuildMember, archiveMember, createGuildMember } from '../handlers/databaseHandler.js';
import { checkRequirements } from './requirements.js';

const db = new Database('guild.db');

export const sheet = new google.auth.JWT(config.sheets.clientEmail, undefined, config.sheets.privateKey, [
  'https://www.googleapis.com/auth/spreadsheets'
]);

sheet.authorize();

export async function weekly(client: Client) {
  schedule(
    '55 11 * * 0',
    async () => {
      const roleDesc: StringObject = {};
      const assignedMembers = new Set();

      for (const [role, data] of Object.entries(hypixelRoles)) {
        roleDesc[role] = '';

        const roleMembers = db
          .prepare(
            `SELECT uuid, discord, weeklyGexp, joined FROM guildMembers WHERE weeklyGexp >= (?) AND uuid NOT IN (${Array.from(
              assignedMembers
            )
              .map(() => '?')
              .join(',')}) ORDER BY weeklyGexp DESC`
          )
          .all(data.gexp, ...Array.from(assignedMembers)) as HypixelGuildMember[];

        roleMembers.sort((a, b) => b.weeklyGexp - a.weeklyGexp);

        for (const i in roleMembers) {
          assignedMembers.add(roleMembers[i].uuid);

          const days = (new Date().getTime() - new Date(roleMembers[i].joined).getTime()) / (1000 * 3600 * 24);

          if (days >= data.days) {
            for (const j in hypixelRoles) {
              if (days >= hypixelRoles[j as HypixelRoleKeys].days) {
                db.prepare('UPDATE guildMembers SET targetRank = ? WHERE uuid = ?').run(
                  `[${hypixelRoles[j as HypixelRoleKeys].name}]`,
                  roleMembers[i].uuid
                );
                break;
              }
            }
          } else {
            db.prepare('UPDATE guildMembers SET targetRank = ? WHERE uuid = ?').run(
              `[${data.name}]`,
              roleMembers[i].uuid
            );
          }

          if (roleMembers[i].discord) {
            roleDesc[role] += `\n\`${parseInt(i, 10) + 1}.\` ${await client.users.fetch(
              roleMembers[i].discord
            )} - \`${abbreviateNumber(roleMembers[i].weeklyGexp)}\``;
          } else {
            roleDesc[role] += `\n\`${parseInt(i, 10) + 1}.\` ${await uuidToName(
              roleMembers[i].uuid
            )} - \`${abbreviateNumber(roleMembers[i].weeklyGexp)}\``;
          }
        }
      }

      const slayerMembers = db
        .prepare(
          `SELECT uuid, discord, weeklyGexp, joined FROM guildMembers WHERE uuid NOT IN (${Array.from(assignedMembers)
            .map(() => '?')
            .join(',')})`
        )
        .all(...Array.from(assignedMembers)) as HypixelGuildMember[];

      for (const i in slayerMembers) {
        const days = (new Date().getTime() - new Date(slayerMembers[i].joined).getTime()) / (1000 * 3600 * 24);

        for (const j in hypixelRoles) {
          if (days >= hypixelRoles[j as HypixelRoleKeys].days) {
            db.prepare('UPDATE guildMembers SET targetRank = ? WHERE uuid = ?').run(
              `[${hypixelRoles[j as HypixelRoleKeys].name}]`,
              slayerMembers[i].uuid
            );
            break;
          }
        }
      }

      const date = new Date();
      date.setDate(date.getDate() - 1);
      const previous = `${doubleDigits(date.getDate())}/${doubleDigits(date.getMonth() + 1)}/${date.getFullYear()}`;
      date.setDate(date.getDate() - 6);
      const prevWeek = `${doubleDigits(date.getDate())}/${doubleDigits(date.getMonth() + 1)}/${date.getFullYear()}`;

      const embed = new EmbedBuilder()
        .setColor(config.colors.discordGray)
        .setTitle(`Weekly Roles Update ${prevWeek} - ${previous}`)
        .setDescription(
          `${Object.entries(roleDesc)
            .filter(([, desc]) => desc.trim() !== '')
            .map(
              ([role, desc]) =>
                `Congrats to the following **${hypixelRoles[role as HypixelRoleKeys].name}** members:${desc}`
            )
            .join('\n\n')}\n\n**Detailed stats can be found in https://dominance.cf/sheets**`
        )
        .setImage(config.guild.banner);

      await textChannels.announcements.send({ content: '<@&1031926129822539786>', embeds: [embed] });
    },
    {
      timezone: 'Asia/Hong_Kong'
    }
  );
}

export async function database() {
  setInterval(async () => {
    const guild = await hypixel.getGuild('name', 'Dominance', {});
    const today = getESTDate();

    const tableInfo = db.prepare('PRAGMA table_info(gexpHistory)').all() as StringObject[];
    const columnExists = tableInfo.some((column) => column.name === formatDateForDb(today));

    if (!columnExists) {
      db.prepare(`ALTER TABLE gexpHistory ADD COLUMN "${formatDateForDb(today)}" INTEGER DEFAULT 0`).run();
      db.prepare(`ALTER TABLE gexpHistoryArchives ADD COLUMN "${formatDateForDb(today)}" INTEGER`).run();
    }

    updateTable('2022-10-17', formatDateForDb(today));

    for (const member of guild.members) {
      const { joinedAtTimestamp, uuid, rank, expHistory } = member;
      const weeklyGexp = member.expHistory.reduce((acc, cur) => acc + cur.exp, 0);
      const currentDay = expHistory[0].day;
      const currentDailyExp = expHistory[0].exp;

      createGuildMember(uuid);

      db.prepare(`UPDATE guildMembers SET (joined, tag, weeklyGexp) = (?, ?, ?) WHERE uuid = ?`).run(
        joinedAtTimestamp,
        `[${rank}]`,
        weeklyGexp,
        uuid
      );

      db.prepare(`UPDATE gexpHistory SET ("${currentDay}") = (?) WHERE uuid = ?`).run(currentDailyExp, uuid);
    }

    const hypixelMemberUuids = guild.members.map((member) => member.uuid);

    const uuidsToCheck = [
      ...(db.prepare('SELECT uuid FROM guildMembers').all() as { uuid: string }[]),
      ...(db.prepare('SELECT uuid FROM gexpHistory').all() as { uuid: string }[])
    ];

    for (const uuid of uuidsToCheck) {
      if (!hypixelMemberUuids.includes(uuid.uuid)) {
        await archiveGuildMember(null, uuid.uuid);
      }
    }
  }, 60 * 1000);
}

export async function gsrun(sheets: JWT, client: Client) {
  setInterval(
    async () => {
      const gsapi = google.sheets({ version: 'v4', auth: sheets });
      const data = db.prepare('SELECT * FROM guildMembers').all() as HypixelGuildMember[];
      const guild = await hypixel.getGuild('name', 'Dominance', {});

      const guildMembers = guild.members;
      const array = [];
      for (let i = data.length - 1; i >= 0; i--) {
        for (let j = Object.keys(data[i]).length; j >= 0; j--) {
          if (
            /[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(Object.keys(data[i])[j]) &&
            !Object.keys(guildMembers[0].expHistory).includes(Object.keys(data[i])[j])
          ) {
            delete data[i][Object.keys(data[i])[j]];
          }
        }
        const { uuid } = data[i];
        data[i].name = await uuidToName(uuid);
        if (data[i].discord) {
          try {
            data[i].discordTag = (await client.users.fetch(data[i].discord)).tag;
          } catch (e) {
            data[i].discordTag = null;
          }
        } else {
          const discordId = uuidToDiscord(uuid);
          if (discordId) {
            db.prepare('UPDATE guildMembers SET discord = ? WHERE uuid = ?').run(discordId, uuid);
            data[i].discord = discordId;
            try {
              data[i].discordTag = (await client.users.fetch(data[i].discord)).tag;
            } catch (e) {
              data[i].discordTag = null;
            }
          } else {
            data[i].discordTag = null;
          }
        }
        array.push(Object.values(data[i]));
      }
      array.sort((a: any, b: any) => b[4] - a[4]);
      const options = {
        spreadsheetId: '1YiNxpvH9FZ6Cl6ZQmBV07EvORvsVTAiq5kD1FgJiKEE',
        range: 'Guild API!A2',
        valueInputOption: 'USER_ENTERED',
        resource: { values: array }
      };
      await gsapi.spreadsheets.values.clear({
        spreadsheetId: '1YiNxpvH9FZ6Cl6ZQmBV07EvORvsVTAiq5kD1FgJiKEE',
        range: 'Guild API!A2:Z126'
      });
      await gsapi.spreadsheets.values.update(options);
    },
    6 * 60 * 1000
  );
}

export async function players() {
  const client = (await import('../index.js')).default;
  const guild = client.guilds.cache.get('242357942664429568') as Guild;
  const breakRole = guild.roles.cache.get(discordRoles.Break) as Role;
  const slayerRole = guild.roles.cache.get(discordRoles.slayer) as Role;
  const eliteRole = guild.roles.cache.get(discordRoles.elite) as Role;
  const heroRole = guild.roles.cache.get(discordRoles.hero) as Role;
  const staffRole = guild.roles.cache.get(discordRoles.staff) as Role;
  let count = 0;

  setInterval(
    async () => {
      const discordId = db
        .prepare('SELECT discord FROM guildMembers')
        .all()
        .map((i) => (i as { discord: string }).discord);
      const members = Array.from(slayerRole.members).concat(
        Array.from(eliteRole.members),
        Array.from(heroRole.members),
        Array.from(staffRole.members)
      );
      for (const member of members) {
        if (!discordId.includes(member[0])) {
          await member[1].roles.remove([slayerRole, eliteRole, heroRole]);
        }
      }
    },
    5 * 60 * 1000
  );

  setInterval(async () => {
    const data = db.prepare('SELECT * FROM guildMembers LIMIT 1 OFFSET ?').get(count) as HypixelGuildMember;

    count++;
    if (count === 126) {
      count = 0;
    }

    if (!data || !data.uuid || !data.tag) {
      return;
    }

    const ingameRole = data.tag.replace(/\[|\]/g, '');

    const skyblockProfilesResponse = (await hypixel.getSkyblockProfiles(data.uuid, { raw: true })) as any;
    if (!skyblockProfilesResponse.success) {
      return;
    }
    const { profiles } = skyblockProfilesResponse;

    let player;
    try {
      player = await hypixel.getPlayer(data.uuid);
    } catch (e) {
      return;
    }

    const bwFkdr = +(player.stats?.bedwars?.finalKDRatio.toFixed(1) ?? 0);
    const bwStars = player.stats?.bedwars?.level ?? 0;
    const duelsWins = player.stats?.duels?.wins ?? 0;
    const duelsWlr = +(player.stats?.duels?.WLRatio.toFixed(1) ?? 0);

    let networth = 0;
    let sa = 0;
    let sbLevel = 0;

    if (profiles) {
      const profile = profiles.find((i: any) => i.selected);
      if (profile) {
        const profileData = profile.members[data.uuid];
        const bankBalance = profile.banking?.balance;
        ({ networth } = await getNetworth(profileData, bankBalance));
        sa = await skillAverage(profileData);
        sbLevel = Math.floor(profileData.leveling?.experience ? profileData.leveling.experience / 100 : 0);
      }
    }

    if (data.targetRank && !['[Staff]', '[Owner]', '[GM]'].includes(data.tag) && data.targetRank !== data.tag) {
      const ign = await uuidToName(data.uuid);
      if (data.targetRank === '[Hero]') {
        await chat(`/g promote ${ign}`);
      } else if (data.targetRank === '[Elite]') {
        if (data.tag === '[Slayer]') {
          await chat(`/g promote ${ign}`);
        } else if (data.tag === '[Hero]') {
          await chat(`/g demote ${ign}`);
        }
      } else if (data.targetRank === '[Slayer]') {
        await chat(`/g demote ${ign}`);
      } else if (['[Slayer]', '[Elite]'].includes(data.tag)) {
        await chat(`/g promote ${ign}`);
      }
    }

    if (data.discord) {
      let member;
      try {
        member = await guild.members.fetch(data.discord);
      } catch (e) {
        await archiveMember(null, data.discord);
        return;
      }

      const bwRole = bwPrestiges[Math.floor(bwStars / 100) * 100];
      for (const roleId of Object.values(bwPrestiges)) {
        if (member.roles.cache.has(roleId) && roleId !== bwRole) {
          await member.roles.remove(roleId);
        }
      }
      if (bwRole) {
        await member.roles.add(bwRole);
      }

      let highestRole = null;
      for (const wins in duelsDivisionRoles) {
        if (duelsWins >= parseInt(wins, 10)) {
          highestRole = duelsDivisionRoles[wins];
        }
      }

      for (const wins in duelsDivisionRoles) {
        const roleId = duelsDivisionRoles[wins];
        if (highestRole === roleId) {
          await member.roles.add(roleId);
        } else if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId);
        }
      }

      if (!['[Owner]', '[GUILDMASTER]'].includes(data.tag)) {
        const ign = player.nickname;
        await member.roles.add(slayerRole);
        const { displayName } = member;
        if (!displayName.toUpperCase().includes(ign.toUpperCase())) {
          if (/\(.*?\)/.test(displayName.split(' ')[1])) {
            await member.setNickname(displayName.replace(displayName.split(' ')[0], ign));
          } else {
            await member.setNickname(ign);
          }
        } else if (!displayName.includes(ign)) {
          await member.setNickname(displayName.replace(new RegExp(ign, 'gi'), ign));
        }

        const memberRoles = member.roles.cache.map((role) => role.id);

        const role = guild.roles.cache.get(discordRoles[ingameRole.toLowerCase() as HypixelRoleKeys]) as Role;
        if (!memberRoles.includes(role.id) && ingameRole !== 'Staff') {
          await member.roles.add(role);
        }

        if (data.targetRank) {
          const targetRole = guild.roles.cache.get(
            discordRoles[toCamelCase(data.targetRank.replace(/\[|\]/g, '')) as HypixelRoleKeys]
          ) as Role;
          if (!memberRoles.includes(targetRole.id)) {
            await member.roles.add(targetRole);
          }
        }

        if (data.tag === '[Slayer]') {
          if (memberRoles.includes(eliteRole.id)) {
            await member.roles.remove(eliteRole);
          }
          if (memberRoles.includes(heroRole.id)) {
            await member.roles.remove(heroRole);
          }
          if (memberRoles.includes(staffRole.id)) {
            await member.roles.remove(staffRole);
          }
        }

        if (data.tag === '[Elite]') {
          if (memberRoles.includes(heroRole.id)) {
            await member.roles.remove(heroRole);
          }
          if (memberRoles.includes(staffRole.id)) {
            await member.roles.remove(staffRole);
          }
        }

        if (data.tag === '[Hero]') {
          if (memberRoles.includes(eliteRole.id)) {
            await member.roles.remove(eliteRole);
          }
          if (memberRoles.includes(staffRole.id)) {
            await member.roles.remove(staffRole);
          }
        }
      }
    }

    const swLevel = player.stats?.skywars?.level ?? 0;
    const { achievementPoints, level } = player;
    const quests = player.achievements.generalQuestMaster;

    db.prepare(
      'UPDATE guildMembers SET (nameColor, reqs, bwStars, bwFkdr, duelsWins, duelsWlr, networth, skillAverage, swLevel, achievementPoints, networkLevel, sbLevel, quests) = (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) WHERE uuid = ?'
    ).run(
      rankTagF(player),
      (await checkRequirements(data.uuid, player)) ? 1 : 0,
      bwStars,
      bwFkdr,
      duelsWins,
      duelsWlr,
      Math.round(networth * 100) / 100 ?? 0,
      Math.round(sa * 100) / 100 ?? 0,
      swLevel,
      achievementPoints,
      level,
      sbLevel,
      quests,
      data.uuid
    );
  }, 7 * 1000);

  setInterval(
    async () => {
      const breakMembers = db
        .prepare('SELECT discord FROM breaks')
        .all()
        .map((i) => (i as { discord: string }).discord);
      for (const member of Array.from(breakRole.members)) {
        if (!breakMembers.includes(member[0])) {
          await member[1].roles.remove(breakRole);
        }
      }
    },
    5 * 60 * 1000
  );
}
