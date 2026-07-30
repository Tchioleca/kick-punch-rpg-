
    (function () {
      "use strict";

      // ---------------- Game State ----------------
      const SAVE_KEY = 'emberhold-save-v1';

      const state = {
        hasSave: false,
        player: null,
        enemy: null,
        inBattle: false,
        playerDefending: false,
        potions: 3,
        mpPotions: 0,
        tomesPurchased: 0,
        slimesDefeated: 0,
        equip: {
          armour: null,  // null | 'basic_armour_plate'
          weapon: null,  // null | 'bronze_sword'
        },
        quests: {
          veteran: {
            phase: 'intro',       // 'intro' → 'hidden_active' → 'hidden_done' → 'main_offered' → 'main_active' → 'main_done' → 'rewarded'
            hiddenSameStrikes: 0, // consecutive same-type swings in the background (100 goal)
            hiddenLastType: null, // last swing type counted: 'vertical' | 'horizontal' | null
            mainSameStrikes: 0,   // same, for the 1000-swing main quest
            mainLastType: null,
            passiveStacks: 0,     // +1 dmg and -1 sp per stack; 1 stack per 1000 same-type strikes
          },
          slimeExtermination: {
            phase: 'available',   // 'available' | 'active' | 'done' | 'claimed'
            slimesKilled: 0,
            goal: 5,
          },
        },
        isResting: false,
        burn: { turnsLeft: 0, damagePerTurn: 0 }, // active burn on the current enemy
        combo: {
          lastSlash: null,           // 'vertical' | 'horizontal' | null
          // Cross Combo (V → H) — leads to Cross Slash
          crossProgress: 0,
          crossUnlocked: false,
          crossMastery: 0,
          crossSkillName: 'Cross Slash', // evolves at mastery 100
          // Rising Cross (H → V) — leads to Rising Cross skill
          risingProgress: 0,
          risingUnlocked: false,
          risingMastery: 0,
          risingSkillName: 'Rising Cross',
          equippedSkills: [], // up to 6 skill IDs chosen before battle
        },
      };

      function getCurrentScreenName() {
        if (document.getElementById('screen-narrator')?.classList.contains('active')) return 'narrator';
        if (document.getElementById('screen-battle')?.classList.contains('active')) return 'battle';
        if (document.getElementById('screen-shop')?.classList.contains('active')) return 'shop';
        if (document.getElementById('screen-guild')?.classList.contains('active')) return 'guild';
        if (document.getElementById('screen-worldmap')?.classList.contains('active')) return 'worldmap';
        return 'title';
      }

      function updateContinueButton() {
        const btn = document.getElementById('btn-continue');
        if (btn) btn.disabled = !state.hasSave;
        const hint = document.getElementById('save-hint');
        if (hint) { hint.textContent = state.hasSave ? 'Progress auto-saves on refresh.' : 'No save yet.'; }
      }

      function saveGame() {
        if (!state.player) return;
        try {
          const snapshot = JSON.parse(JSON.stringify(state));
          snapshot.currentScreen = getCurrentScreenName();
          snapshot.narratorState = {
            index: narratorIndex,
            script: NARRATOR_SCRIPT,
            nameDone: narratorNameDone,
            waitingForName: narratorWaitingForName,
            waitingForChoice: narratorWaitingForChoice,
          };
          localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
          state.hasSave = true;
          updateContinueButton();
        } catch (err) {
          console.warn('Could not save game:', err);
        }
      }

      function loadGame() {
        try {
          const raw = localStorage.getItem(SAVE_KEY);
          if (!raw) {
            state.hasSave = false;
            updateContinueButton();
            return false;
          }
          const saved = JSON.parse(raw);
          if (!saved || !saved.player) {
            state.hasSave = false;
            updateContinueButton();
            return false;
          }

          Object.assign(state, saved);
          state.hasSave = true;

          if (saved.narratorState) {
            narratorIndex = saved.narratorState.index || 0;
            narratorNameDone = !!saved.narratorState.nameDone;
            narratorWaitingForName = !!saved.narratorState.waitingForName;
            narratorWaitingForChoice = !!saved.narratorState.waitingForChoice;
            NARRATOR_SCRIPT = Array.isArray(saved.narratorState.script) && saved.narratorState.script.length
              ? saved.narratorState.script
              : [...NARRATOR_SCRIPT_FULL];
          }

          updateContinueButton();
          return true;
        } catch (err) {
          console.warn('Could not load save:', err);
          state.hasSave = false;
          updateContinueButton();
          return false;
        }
      }

      function restoreSavedView() {
        if (!state.player) return;
        const savedScreen = state.currentScreen || 'worldmap';

        refreshWorldMap();
        refreshBattleSkillBar();

        if (savedScreen === 'battle' && state.enemy) {
          refreshBattleUI();
          document.getElementById('battle-menu-wrapper').style.display = 'flex';
          document.getElementById('result-banner').classList.remove('show');
          showScreen('battle');
          return;
        }

        if (savedScreen === 'shop') { refreshShop(); showScreen('shop'); return; }
        if (savedScreen === 'guild') { refreshGuildScreen(); refreshSlimeQuest(); showScreen('guild'); return; }
        if (savedScreen === 'narrator') { showScreen('worldmap'); return; }
        showScreen('worldmap');
      }

      // ---------------- Character Creation ----------------

      // Random integer from 1 to max, inclusive.
      function rollStat(max) {
        return Math.floor(Math.random() * max) + 1;
      }

      // Level 1 -> 2 needs 100 XP. Every level after that needs 50% more
      // XP than the level before it (100, 150, 225, 337.5 -> 338, ...).
      const BASE_XP_TO_LEVEL = 100;
      const XP_GROWTH_RATE = 1.5;

      function createCharacter() {
        const player = {
          name: "Wanderer",

          // Core attributes, rolled 1-5 at creation
          STA: rollStat(5),
          STR: rollStat(5),
          INT: rollStat(5),
          DEX: rollStat(5),

          // Proficiencies, rolled at creation
          magicProficiency: rollStat(10),        // 1-10
          swordsmanshipProficiency: rollStat(5), // 1-5
          bodyProficiency: rollStat(5),          // 1-5

          // Progression
          level: 1,
          xp: 0,
          xpToNextLevel: BASE_XP_TO_LEVEL,

          // Usage counters - these feed the derived-stat formulas below.
          // "So far" in the spec means cumulative, so these only ever grow.
          totalDamageTaken: 0,
          swordAttacksUsed: 0,
          totalMpSpent: 0,
          totalSpSpent: 0,
          fireballCastsUsed: 0,

          // Incoming-damage mitigation. No formula defined for this yet,
          // so it stays a fixed value for now (flagged in chat).
          def: 3,

          gold: 50,
        };

        recalcMaxPools(player);   // sets maxHp / maxMp / maxSp from the formulas below
        player.hp = player.maxHp;
        player.mp = player.maxMp;
        player.sp = player.maxSp;

        return player;
      }

      // Growth-rate tuning for the "usage" terms below (damage taken, mp spent,
      // sword swings). These divisors are calibrated so that at *average*
      // proficiency, roughly 100 uses raises the term by about +2:
      //   - sword: 100 swings * avg proficiency(3)              / 150 = 2
      //   - body:  100 hits * ~3 dmg/hit * avg proficiency(3)    / 450 = 2
      //   - magic: 100 casts * ~3 mp/cast * avg proficiency(5.5) / 800 = 2
      //   - sp:    100 spends * ~3 sp/spend * avg proficiency(3) / 450 = 2
      // Proficiency still matters - higher proficiency grows faster than this
      // baseline, lower proficiency grows slower - but nothing snowballs after
      // just a handful of uses anymore.
      const SWORD_GROWTH_DIVISOR = 150;
      const BODY_GROWTH_DIVISOR = 450;
      const MAGIC_GROWTH_DIVISOR = 800;
      const SP_GROWTH_DIVISOR = 450;
      const FIREBALL_GROWTH_DIVISOR = 275; // 100 casts * avg magicProficiency(5.5) / 275 = 2

      // Sword skill tuning: every SWORD_SKILL_MILESTONE lifetime sword swings,
      // the "sword skill" gains a level, which reduces the SP cost of a swing.
      // Higher swordsmanshipProficiency reduces the cost faster per level.
      const SWORD_SKILL_MILESTONE = 100;
      const SWORD_SP_COST_BASE = 4; // Lv1 Vertical/Horizontal Slash SP cost

      // Equipment stat bonuses
      const ARMOUR_PLATE_HP_BONUS = 4;  // Basic Armour Plate: +4 max HP (shown in brown)
      const BRONZE_SWORD_DMG_BONUS = 1; // Bronze Sword: +1 to all sword attack damage

      // Fireball skill tuning: mirrors the sword skill above, but keyed off
      // magicProficiency and a lifetime "casts" counter instead.
      const FIREBALL_SKILL_MILESTONE = 100;
      const FIREBALL_MP_COST_BASE = 3; // Lv1 Fireball MP cost

      // HP = STA * (level/2) + (damage taken so far * bodyProficiency) / BODY_GROWTH_DIVISOR + level
      // MP = INT * (level/2) + (MP spent so far * magicProficiency) / MAGIC_GROWTH_DIVISOR + level
      // SP = (STA + DEX) * level * 7 + (SP spent so far * swordsmanshipProficiency) / SP_GROWTH_DIVISOR + level * 4
      //   SP is scaled up relative to HP/MP specifically so that whole-number SP
      //   costs (below) have room to step down as the sword skill levels up,
      //   while still starting a fresh character at "at least ~10 Lv1 sword
      //   swings" for average-or-better STA/DEX rolls.
      // Recalculated whenever level, damage-taken, mp-spent, or sp-spent changes.
      function recalcMaxPools(player) {
        const armourBonus = (state.equip && state.equip.armour === 'basic_armour_plate') ? ARMOUR_PLATE_HP_BONUS : 0;

        player.maxHp = Math.max(1, Math.round(
          player.STA * (player.level / 2) +
          (player.totalDamageTaken * player.bodyProficiency) / BODY_GROWTH_DIVISOR +
          player.level
        ) + armourBonus);

        player.maxMp = Math.max(0, Math.round(
          player.INT * (player.level / 2) +
          (player.totalMpSpent * player.magicProficiency) / MAGIC_GROWTH_DIVISOR +
          player.level
        ));

        player.maxSp = Math.max(1, Math.round(
          (player.STA + player.DEX) * player.level * 7 +
          (player.totalSpSpent * player.swordsmanshipProficiency) / SP_GROWTH_DIVISOR +
          player.level * 4
        ));

        // Totals only ever grow, so max pools only ever grow too - this clamp
        // just guards against current value ever exceeding a freshly computed max.
        if (player.hp !== undefined) player.hp = Math.min(player.hp, player.maxHp);
        if (player.mp !== undefined) player.mp = Math.min(player.mp, player.maxMp);
        if (player.sp !== undefined) player.sp = Math.min(player.sp, player.maxSp);
      }

      // Sword skill level: starts at 1, gains a level every SWORD_SKILL_MILESTONE
      // lifetime swings (Vertical or Horizontal - they share the same counter).
      function swordSkillLevel(player) {
        return 1 + Math.floor(player.swordAttacksUsed / SWORD_SKILL_MILESTONE);
      }

      // SP cost of a Vertical or Horizontal Slash at the character's current
      // sword skill level. Starts at SWORD_SP_COST_BASE (4) and drops by 1-2
      // per sword-skill level - 2 if swordsmanshipProficiency is decent (3+),
      // otherwise 1 - floored so it's never free.
      function swordSpCost(player) {
        const skillLevel = swordSkillLevel(player);
        const reductionPerLevel = player.swordsmanshipProficiency >= 3 ? 2 : 1;
        const passiveReduction = (state.quests && state.quests.veteran) ? state.quests.veteran.passiveStacks : 0;
        return Math.max(1, SWORD_SP_COST_BASE - reductionPerLevel * (skillLevel - 1) - passiveReduction);
      }

      // Sword attack damage = STR * (level/2) + (times used sword attacks * swordsmanshipProficiency) / SWORD_GROWTH_DIVISOR
      // This is the "Vertical Slash" damage.
      // Crit Chance = DEX × 0.3  (as a percentage, so DEX 3 → 0.9%, DEX 5 → 1.5%)
      // Returned as a 0–1 decimal for Math.random() comparisons.
      function critChance(player) {
        return player.DEX * 0.003; // DEX × 0.3 / 100
      }

      // Rolls for a crit. Returns { isCrit, multiplier }.
      // isCrit true → multiplier 1.5, otherwise 1.
      function rollCrit(player) {
        const isCrit = Math.random() < critChance(player);
        return { isCrit, multiplier: isCrit ? 1.5 : 1 };
      }

      // ---------------- Combo / Technique System ----------------

      const CROSS_COMBO_UNLOCK_AT = 20;   // V→H sequences to unlock Cross Slash
      const RISING_COMBO_UNLOCK_AT = 20;   // H→V sequences to unlock Rising Cross
      const COMBO_MASTERY_EVOLVE_AT = 100;  // uses of the combo skill before it evolves

      // Possible evolution names for each path
      const CROSS_EVOLUTIONS = ['Bloody Cross', 'Twin Fang', 'Crimson X'];
      const RISING_EVOLUTIONS = ['Sky Splitter', 'Storm Cleaver', 'Gale Rise'];

      // Called after every sword action with the slash type used ('vertical'|'horizontal').
      // Detects sequences, increments progress, triggers unlocks/evolutions, refreshes UI.
      function recordSlash(type) {
        const c = state.combo;
        const prev = c.lastSlash;
        c.lastSlash = type;

        if (prev === 'vertical' && type === 'horizontal') {
          // Cross Combo sequence detected (V → H)
          if (!c.crossUnlocked) {
            c.crossProgress += 1;
            refreshComboUI();
            if (c.crossProgress >= CROSS_COMBO_UNLOCK_AT) {
              c.crossUnlocked = true;
              log('✨ New Technique Unlocked: Cross Slash! (Sword sub-menu)');
              refreshComboUI();
            }
          } else {
            // Already unlocked — using V then H manually still builds mastery
            // (the real mastery counter is in the Cross Slash handler itself)
          }
        }

        if (prev === 'horizontal' && type === 'vertical') {
          // Rising Cross sequence detected (H → V)
          if (!c.risingUnlocked) {
            c.risingProgress += 1;
            refreshComboUI();
            if (c.risingProgress >= RISING_COMBO_UNLOCK_AT) {
              c.risingUnlocked = true;
              log('✨ New Technique Unlocked: Rising Cross! (Sword sub-menu)');
              refreshComboUI();
            }
          }
        }

        refreshSwordMenu();
        trackVeteranStrike(type);   // veteran quest: count consecutive same-type swings
      }

      // Increments a combo skill's mastery counter and handles evolution.
      function addComboMastery(which) {
        const c = state.combo;
        if (which === 'cross') {
          c.crossMastery += 1;
          if (c.crossMastery === COMBO_MASTERY_EVOLVE_AT) {
            c.crossSkillName = CROSS_EVOLUTIONS[Math.floor(Math.random() * CROSS_EVOLUTIONS.length)];
            log(`✨ Cross Slash evolved into: ${c.crossSkillName}!`);
          }
        } else {
          c.risingMastery += 1;
          if (c.risingMastery === COMBO_MASTERY_EVOLVE_AT) {
            c.risingSkillName = RISING_EVOLUTIONS[Math.floor(Math.random() * RISING_EVOLUTIONS.length)];
            log(`✨ Rising Cross evolved into: ${c.risingSkillName}!`);
          }
        }
        refreshComboUI();
      }

      // Refreshes the "Techniques" section on the character sheet.
      // Refreshes combo-related UI. Technique progress now lives in the Skill Sheet
      // modal; we only need to refresh it if the modal is currently open.
      function refreshComboUI() {
        const modal = document.getElementById('modal-skills');
        if (modal && modal.classList.contains('open')) refreshSkillModal();
      }

      // Shows/hides the combo skill buttons in the sword sub-menu.
      // Delegates to refreshBattleSkillBar which reads the equipped-skills list.
      function refreshSwordMenu() {
        refreshBattleSkillBar();
      }

      // Sword attack base damage (Vertical Slash). Crits applied by the caller.
      function swordAttackDamage(player) {
        const weaponBonus = (state.equip && state.equip.weapon === 'bronze_sword') ? BRONZE_SWORD_DMG_BONUS : 0;
        const passiveBonus = (state.quests && state.quests.veteran) ? state.quests.veteran.passiveStacks : 0;
        return Math.round(
          player.STR * (player.level / 2) +
          (player.swordAttacksUsed * player.swordsmanshipProficiency) / SWORD_GROWTH_DIVISOR
        ) + weaponBonus + passiveBonus;
      }

      // Horizontal Slash: same base as Vertical Slash, plus a DEX-scaled crit roll.
      // Roll 1-100; rolls over 70 trigger a bonus of up to 50% extra damage.
      // How close the roll is to 100 (past the 70 mark) AND the player's DEX
      // both scale how much of that up-to-50% bonus is actually granted.
      function horizontalSlashDamage(player) {
        const base = swordAttackDamage(player);
        const roll = Math.floor(Math.random() * 100) + 1; // 1-100

        let bonusPercent = 0;
        if (roll > 70) {
          const rollFactor = (roll - 70) / 30;            // 0..1 - how far past the threshold
          const dexFactor = Math.min(player.DEX, 5) / 5;   // 0.2..1 - DEX out of its 1-5 range
          bonusPercent = 50 * rollFactor * dexFactor;      // up to 50%, scaled by DEX
        }

        const damage = Math.round(base * (1 + bonusPercent / 100));
        return { damage, roll, bonusPercent };
      }

      // Fireball skill level: starts at 1, gains a level every
      // FIREBALL_SKILL_MILESTONE lifetime casts.
      function fireballSkillLevel(player) {
        return 1 + Math.floor(player.fireballCastsUsed / FIREBALL_SKILL_MILESTONE);
      }

      // MP cost of a Fireball at the character's current fireball skill level.
      // Starts at FIREBALL_MP_COST_BASE (3) and drops by 1-2 per skill level -
      // 2 if magicProficiency is decent (6+ out of its 1-10 range), otherwise 1 -
      // floored at 1 MP, same "never free" rule as the sword.
      function fireballMpCost(player) {
        const skillLevel = fireballSkillLevel(player);
        const reductionPerLevel = player.magicProficiency >= 6 ? 2 : 1;
        return Math.max(1, FIREBALL_MP_COST_BASE - reductionPerLevel * (skillLevel - 1));
      }

      // Fireball damage = INT * (level/2) + (times cast * magicProficiency) / FIREBALL_GROWTH_DIVISOR
      function fireballDamage(player) {
        return Math.round(
          player.INT * (player.level / 2) +
          (player.fireballCastsUsed * player.magicProficiency) / FIREBALL_GROWTH_DIVISOR
        );
      }

      // Spends current MP immediately (drained by Fireball), queues it toward
      // the lifetime total - see battleTally below.
      function spendMp(player, amount) {
        const actual = Math.min(player.mp, amount);
        player.mp -= actual;
        battleTally.mpSpent += actual;
        updateTallyUI();
        return actual;
      }

      // Spends current SP immediately (drained by sword skills), queues it
      // toward the lifetime total the same way spendMp does for MP.
      function spendSp(player, amount) {
        const actual = Math.min(player.sp, amount);
        player.sp -= actual;
        battleTally.spSpent += actual;
        updateTallyUI();
        return actual;
      }

      // ---------------- Battle Tally ----------------
      // Stats (maxHp, maxMp, maxSp, sword/fireball damage, sword/fireball costs)
      // only change once a battle ends - no mid-fight snowballing. The raw
      // counters they're built from still tick live during the fight, both in
      // state and in the DOM, and get folded into the permanent character
      // totals when the fight resolves.
      let battleTally = { damageTaken: 0, mpSpent: 0, spSpent: 0, swordAttacks: 0, fireballCasts: 0 };

      function resetBattleTally() {
        battleTally = { damageTaken: 0, mpSpent: 0, spSpent: 0, swordAttacks: 0, fireballCasts: 0 };
        updateTallyUI();
      }

      function updateTallyUI() {
        document.getElementById('tally-dmg').textContent = battleTally.damageTaken;
        document.getElementById('tally-sword').textContent = battleTally.swordAttacks;
        document.getElementById('tally-sp').textContent = battleTally.spSpent;
        document.getElementById('tally-fireball').textContent = battleTally.fireballCasts;
        document.getElementById('tally-mp').textContent = battleTally.mpSpent;
      }

      // Folds this fight's tally into the character's permanent totals and
      // recalculates maxHp/maxMp/maxSp from the (now updated) totals.
      function commitBattleTally() {
        const swordSkillBefore = swordSkillLevel(state.player);
        const fireballSkillBefore = fireballSkillLevel(state.player);

        state.player.totalDamageTaken += battleTally.damageTaken;
        state.player.totalMpSpent += battleTally.mpSpent;
        state.player.totalSpSpent += battleTally.spSpent;
        state.player.swordAttacksUsed += battleTally.swordAttacks;
        state.player.fireballCastsUsed += battleTally.fireballCasts;
        recalcMaxPools(state.player);

        const swordSkillAfter = swordSkillLevel(state.player);
        if (swordSkillAfter > swordSkillBefore) {
          log(`Your sword technique advances to Lv ${swordSkillAfter}! Slashes now cost ${swordSpCost(state.player)} SP.`);
        }
        const fireballSkillAfter = fireballSkillLevel(state.player);
        if (fireballSkillAfter > fireballSkillBefore) {
          log(`Your Fireball mastery advances to Lv ${fireballSkillAfter}! It now costs ${fireballMpCost(state.player)} MP.`);
        }
      }

      // ---------------- Veteran Swordsman Quest ----------------

      const VETERAN_HIDDEN_GOAL = 100;   // consecutive same-type swings to trigger first check-in
      const VETERAN_MAIN_GOAL = 1000;  // for the real quest and passive unlock
      const VETERAN_PASSIVE_PER = 1000;  // stacks of passive: 1 per 1000 same-type strikes

      // Called by recordSlash on every sword swing (vertical/horizontal, not combos).
      // Tracks consecutive same-type sequences for both quest phases silently.
      function trackVeteranStrike(type) {
        const vq = state.quests.veteran;

        // Hidden quest counter (100 goal)
        if (vq.phase === 'hidden_active') {
          if (type === vq.hiddenLastType) {
            vq.hiddenSameStrikes += 1;
            if (vq.hiddenSameStrikes >= VETERAN_HIDDEN_GOAL) {
              vq.phase = 'hidden_done';
              // Silently unlock — player discovers it when talking to the veteran again
            }
          } else {
            // Changed attack type — reset the run but keep the type
            vq.hiddenLastType = type;
            vq.hiddenSameStrikes = 1;
          }
        }

        // Main quest counter (1000 goal)
        if (vq.phase === 'main_active') {
          if (type === vq.mainLastType) {
            vq.mainSameStrikes += 1;
            if (vq.mainSameStrikes >= VETERAN_MAIN_GOAL) {
              vq.phase = 'main_done';
              log('Quest complete: return to the Guild and speak with the Veteran Swordsman.');
            }
          } else {
            vq.mainLastType = type;
            vq.mainSameStrikes = 1;
          }
        }

        // Passive upgrade: check if rewarded and crosses another 1000-threshold
        if (vq.phase === 'rewarded') {
          // Use mainSameStrikes as the ongoing passive counter after quest completion
          if (type === vq.mainLastType) {
            vq.mainSameStrikes += 1;
            const newStacks = Math.floor(vq.mainSameStrikes / VETERAN_PASSIVE_PER);
            if (newStacks > vq.passiveStacks) {
              vq.passiveStacks = newStacks;
              log(`⚔ Sword mastery deepens! Sword attacks now deal +${vq.passiveStacks} damage and cost -${vq.passiveStacks} SP.`);
            }
          } else {
            vq.mainLastType = type;
            // Don't reset mainSameStrikes after reward — keep counting from current total
            // (but change the type tracking so it counts fresh from this type)
            const baseCount = vq.passiveStacks * VETERAN_PASSIVE_PER;
            vq.mainSameStrikes = Math.max(baseCount, vq.mainSameStrikes);
          }
        }
      }

      // Returns the veteran's dialogue and actions for the current quest phase.
      function veteranDialogue() {
        const vq = state.quests.veteran;
        switch (vq.phase) {
          case 'intro':
            return {
              lines: [
                '"Ehhh... young adventurer. What do you want?"',
                '"Tips? I know of no tips."',
                '"Go swing your sword at the training dummy."',
              ],
              action: () => {
                // Hidden quest (100 same-type strikes) starts silently the moment they close this dialogue
                vq.phase = 'hidden_active';
                vq.hiddenLastType = null;
                vq.hiddenSameStrikes = 0;
              },
              buttonText: null, // fires automatically on close — no button needed
            };
          case 'hidden_active':
            return {
              lines: [
                '"...You\'re still here?"',
                '"I said — go practice. Training dummy. Now."',
              ],
              action: null, buttonText: null,
            };
          case 'hidden_done':
            return {
              lines: [
                '*The veteran squints at you.*',
                '"Hm. Your body seems a bit different."',
                '"Have you been practicing those sword swings?"',
                '"...Keep it up."',
                '"Come back when you\'ve done it for 1,000 swings. I might have something for you."',
              ],
              action: () => {
                vq.phase = 'main_offered';
              },
              buttonText: null,
            };
          case 'main_offered':
            return {
              lines: [
                '"1,000 swings of the same strike. That\'s the quest."',
                '"Vertical or horizontal — pick one and don\'t waver."',
                '"You up for it?"',
              ],
              action: () => {
                vq.phase = 'main_active';
                vq.mainLastType = null;
                vq.mainSameStrikes = 0;
              },
              buttonText: 'Accept quest',
            };
          case 'main_active':
            const pct = Math.min(100, Math.round(vq.mainSameStrikes / VETERAN_MAIN_GOAL * 100));
            return {
              lines: [
                '"Still at it?"',
                `"${vq.mainSameStrikes} / 1,000 consecutive same-strike swings. ${pct}% done."`,
                '"Don\'t switch. That\'s cheating yourself."',
              ],
              action: null, buttonText: null,
              progress: { current: vq.mainSameStrikes, goal: VETERAN_MAIN_GOAL },
            };
          case 'main_done':
            return {
              lines: [
                '*He sets down his drink slowly.*',
                '"...You did it."',
                '"1,000 swings. Same strike. Every time."',
                '"Most people give up. They always want variety."',
                '"You\'re different. Take this — it\'s not a sword. It\'s a principle."',
              ],
              action: () => {
                vq.phase = 'rewarded';
                vq.passiveStacks = 1; // first stack granted on reward
                vq.mainSameStrikes = VETERAN_PASSIVE_PER; // already at 1000
              },
              buttonText: 'Claim reward',
            };
          case 'rewarded':
            const stacks = vq.passiveStacks;
            return {
              lines: [
                '"You\'ve got the principle now."',
                `"Passive: +${stacks} sword damage, -${stacks} SP cost per swing."`,
                '"Keep repeating the same strike — another thousand gets you another stack."',
                '"There\'s no ceiling. Only dedication."',
              ],
              action: null, buttonText: null,
            };
        }
      }

      // ---------------- Guild Screen JS ----------------

      function openGuild() {
        refreshGuildScreen();
        refreshSlimeQuest();
        showScreen('guild');
      }

      // ---- Slime Extermination Quest helpers ----

      function refreshSlimeQuest() {
        const q = state.quests.slimeExtermination;
        const tag = document.getElementById('quest-slime-status-tag');
        const progress = document.getElementById('quest-slime-progress');
        const bar = document.getElementById('quest-slime-bar');
        const label = document.getElementById('quest-slime-label');
        const action = document.getElementById('quest-slime-action');
        if (!tag) return;

        action.innerHTML = '';

        switch (q.phase) {
          case 'available':
            tag.textContent = 'Available';
            tag.style.background = 'var(--sage)';
            progress.style.display = 'none';
            const acceptBtn = document.createElement('button');
            acceptBtn.className = 'btn small';
            acceptBtn.textContent = 'Accept Quest';
            acceptBtn.addEventListener('click', () => {
              q.phase = 'active';
              q.slimesKilled = 0;
              refreshSlimeQuest();
            });
            action.appendChild(acceptBtn);
            break;

          case 'active':
            tag.textContent = 'In Progress';
            tag.style.background = 'var(--mana)';
            progress.style.display = 'block';
            bar.style.width = Math.round(q.slimesKilled / q.goal * 100) + '%';
            label.textContent = `${q.slimesKilled} / ${q.goal} slimes defeated`;
            break;

          case 'done':
            tag.textContent = 'Complete!';
            tag.style.background = 'var(--blood)';
            progress.style.display = 'block';
            bar.style.width = '100%';
            label.textContent = `${q.goal} / ${q.goal} slimes defeated`;
            const claimBtn = document.createElement('button');
            claimBtn.className = 'btn small';
            claimBtn.textContent = '🎁 Claim Reward';
            claimBtn.addEventListener('click', () => {
              q.phase = 'claimed';
              state.player.gold += 20;
              state.potions += 5;
              refreshSlimeQuest();
              refreshWorldMap();
              log('Quest reward claimed: +20 Gold, +5 HP Potions!');
            });
            action.appendChild(claimBtn);
            break;

          case 'claimed':
            tag.textContent = 'Claimed';
            tag.style.background = 'var(--leather)';
            progress.style.display = 'block';
            bar.style.width = '100%';
            label.textContent = 'Reward collected. Well done, adventurer.';
            break;
        }
      }

      function refreshGuildScreen() {
        // Nothing to render inline for the veteran anymore — dialogue opens in an overlay.
        // Just make sure the Talk button handler is wired (idempotent via one-time flag).
      }

      // ---- Veteran Swordsman Dialogue Overlay ----
      // Plays lines one-by-one using the same narrator toast style.
      // Tap anywhere to advance; action button (Accept / Claim) appears on the last line.

      let veteranDialogueIndex = 0;
      let veteranDialogueLines = [];
      let veteranDialogueAction = null;
      let veteranDialogueButtonText = null;
      let veteranDialogueProgress = null;
      let veteranDialogueWaiting = false;

      function startVeteranDialogue() {
        const dia = veteranDialogue();
        veteranDialogueIndex = 0;
        veteranDialogueWaiting = false;
        veteranDialogueProgress = dia.progress || null;
        veteranDialogueButtonText = dia.buttonText || null;

        // fireOnOpen: true → transition the phase before showing dialogue
        // (used for phases like hidden_done where the dialogue IS the post-transition lines)
        if (dia.fireOnOpen && dia.action && !dia.buttonText) {
          dia.action();
          const updated = veteranDialogue();
          veteranDialogueLines = updated.lines;
          veteranDialogueAction = updated.action || null;
          veteranDialogueButtonText = updated.buttonText || null;
          veteranDialogueProgress = updated.progress || null;
        } else {
          veteranDialogueLines = dia.lines;
          // action without a button fires on close (e.g. intro → hidden_active)
          veteranDialogueAction = dia.action || null;
        }

        document.getElementById('veteran-toast-box').innerHTML = '';
        document.getElementById('screen-veteran-dialogue').style.display = 'flex';
        showVeteranLine();
      }

      function showVeteranLine() {
        const box = document.getElementById('veteran-toast-box');

        // Dim all previous toasts
        box.querySelectorAll('.narrator-toast:not(.dim)').forEach(t => t.classList.add('dim'));

        const isLast = veteranDialogueIndex >= veteranDialogueLines.length - 1;
        const text = veteranDialogueLines[veteranDialogueIndex] || '';

        const toast = document.createElement('div');
        const isImportant = text.startsWith('*') && text.endsWith('*');
        toast.className = 'narrator-toast' + (isImportant ? ' narrator-important' : '');
        toast.textContent = isImportant ? text.slice(1, -1) : text;

        // Progress bar for main quest active phase
        if (veteranDialogueProgress && isLast) {
          const pct = Math.min(100, Math.round(veteranDialogueProgress.current / veteranDialogueProgress.goal * 100));
          const barEl = document.createElement('div');
          barEl.style.cssText = 'margin-top:8px;';
          barEl.innerHTML = `
        <div style="font-family:Cinzel;font-size:0.62rem;letter-spacing:0.05em;text-transform:uppercase;color:rgba(201,162,39,0.7);margin-bottom:4px;">Quest Progress</div>
        <div style="width:100%;height:8px;border-radius:4px;background:rgba(255,255,255,0.1);overflow:hidden;margin-bottom:3px;">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--gold-light),var(--gold));transition:width 0.3s;"></div>
        </div>
        <div style="font-size:0.68rem;color:rgba(201,162,39,0.8);">${veteranDialogueProgress.current} / ${veteranDialogueProgress.goal} consecutive same-type strikes</div>`;
          toast.appendChild(barEl);
        }

        // On the last line: show action button OR tap-to-close prompt
        if (isLast) {
          if (veteranDialogueButtonText && veteranDialogueAction) {
            veteranDialogueWaiting = true;
            const row = document.createElement('div');
            row.className = 'narrator-choice-row';
            const btn = document.createElement('button');
            btn.className = 'narrator-choice-btn';
            btn.textContent = veteranDialogueButtonText;
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              veteranDialogueAction();
              closeVeteranDialogue();
              // Quest screen may have changed (e.g. accepted quest) — if guild still showing, refresh
              refreshSlimeQuest();
            });
            row.appendChild(btn);
            const dismissBtn = document.createElement('button');
            dismissBtn.className = 'narrator-choice-btn';
            dismissBtn.textContent = 'Not yet';
            dismissBtn.style.opacity = '0.6';
            dismissBtn.addEventListener('click', (e) => { e.stopPropagation(); closeVeteranDialogue(); });
            row.appendChild(dismissBtn);
            toast.appendChild(row);
          } else {
            const prompt = document.createElement('div');
            prompt.className = 'narrator-prompt';
            prompt.textContent = '— tap to leave —';
            toast.appendChild(prompt);
          }
        } else {
          const prompt = document.createElement('div');
          prompt.className = 'narrator-prompt';
          prompt.textContent = '— tap to continue —';
          toast.appendChild(prompt);
        }

        box.appendChild(toast);
        setTimeout(() => { box.scrollTop = box.scrollHeight; }, 20);
      }

      function closeVeteranDialogue() {
        // Fire any pending action that wasn't tied to a button (e.g. intro → hidden_active)
        if (veteranDialogueAction && !veteranDialogueButtonText) {
          veteranDialogueAction();
          veteranDialogueAction = null;
        }
        document.getElementById('screen-veteran-dialogue').style.display = 'none';
        document.getElementById('veteran-toast-box').innerHTML = '';
        veteranDialogueWaiting = false;
      }

      // Tap anywhere on the overlay advances the conversation
      document.getElementById('screen-veteran-dialogue').addEventListener('click', (e) => {
        if (veteranDialogueWaiting) return;
        if (e.target.closest('.narrator-choice-btn')) return;
        const isLast = veteranDialogueIndex >= veteranDialogueLines.length - 1;
        if (isLast) {
          // Last line with no action button — tap closes
          closeVeteranDialogue();
          return;
        }
        veteranDialogueIndex++;
        showVeteranLine();
      });

      // Wire the Talk button — re-queries each call so it's safe if HTML re-renders
      document.getElementById('btn-talk-veteran').addEventListener('click', () => {
        startVeteranDialogue();
      });

      document.getElementById('guild-back').addEventListener('click', () => {
        refreshWorldMap();
        showScreen('worldmap');
      });

      // Only one enemy type for now: a slime whose stats scale off the
      // player's current level each time a battle starts.
      function createSlimeEncounter(playerLevel) {
        // First 10 slimes are always Lv 1 regardless of player level — a gentle
        // on-ramp before the scaling kicks in.
        const isEarlyGame = state.slimesDefeated < 10;
        const level = isEarlyGame
          ? 1
          : playerLevel + Math.floor(Math.random() * 2) + 1; // random +1 or +2

        const hp = (Math.floor(Math.random() * 5) + 1) + level; // random(1-5) + lv

        return {
          name: "Basic Slime",
          emblem: "🟢",
          level: level,
          hp: hp,
          maxHp: hp,
          atk: Math.floor(Math.random() * 5) + 1,  // random 1-5
          def: Math.floor(Math.random() * 5) + 1,  // random 1-5
          xp: 10 + level,
          gold: Math.floor(Math.random() * 9) + 1, // random 1-9
        };
      }

      // Training dummy: same battle flow as a real fight, but it never attacks,
      // its HP scales with the player instead of being random, it always gives
      // XP equal to the player's current level, and no gold.
      function createTrainingDummy(playerLevel) {
        const hp = playerLevel * 5;
        return {
          name: "Training Dummy",
          emblem: "🎯",
          level: playerLevel,
          hp: hp,
          maxHp: hp,
          atk: 0,
          def: 0,
          xp: playerLevel,
          gold: 0,
          isTrainingDummy: true,
        };
      }

      // ---------------- DOM refs ----------------
      const screens = {
        title: document.getElementById('screen-title'),
        worldmap: document.getElementById('screen-worldmap'),
        battle: document.getElementById('screen-battle'),
        shop: document.getElementById('screen-shop'),
        guild: document.getElementById('screen-guild'),
      };

      function showScreen(name) {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        screens[name].classList.add('active');
        state.currentScreen = name;
      }

      // ---------------- Title Screen ----------------
      document.getElementById('btn-new-game').addEventListener('click', () => {
        startNarrator();
      });

      document.getElementById('btn-continue').addEventListener('click', () => {
        if (!state.hasSave) return;
        loadGame();
        restoreSavedView();
      });

      // ---------------- Narrator ----------------
      // The narrator plays before the first world-map view on a New Game.
      // Each entry in the script is { text, pause, important, isNamePrompt }.
      // pause = ms to wait after showing this line before auto-advancing
      //   (or 0 = wait for a tap/click anywhere to continue).
      // After a tap the previous line dims and the next appears.

      // Full script — played in order. Two special line types:
      //   isChoicePrompt: shows Yes/No buttons; player answer selects which scriptKey to run next.
      //   isNamePrompt: shows a name text field.
      // scriptKey references named branches defined in NARRATOR_BRANCHES below.
      const NARRATOR_SCRIPT_FULL = [
        { text: "...Ah... you're awake.", pause: 0 },
        { text: "Welcome, traveler.", pause: 0 },
        {
          isChoicePrompt: true,
          text: "Is this your first life in this realm, traveler? You look like... an old soul.",
          yesLabel: "First time here",
          noLabel: "I know this place",
          yesKey: 'full',
          noKey: 'veteran',
        },
      ];

      const NARRATOR_BRANCHES = {
        full: [
          { text: "This doesn't feel like your first life, does it?", pause: 0 },
          { text: "Perhaps you've walked countless worlds before. Perhaps this is your very first. Either way, fate has brought you here...", pause: 0 },
          { text: "Welcome to Emberhold.", important: true, pause: 0 },
          { text: "A land of ancient forests, forgotten ruins, wandering merchants, ambitious adventurers... and creatures that would gladly make you their next meal.", pause: 0 },
          { text: "Before your journey begins, there is something you should understand.", pause: 0 },
          { text: "In Emberhold, genetics determine how you begin—not how you end.", important: true, pause: 0 },
          { text: "Your natural talents, attributes, and proficiencies are not yours to choose. They are gifts... or burdens... bestowed upon you at birth.", pause: 0 },
          { text: "Do not be alarmed if you cannot assign your starting statistics. That is by design.", pause: 0 },
          { text: "Some are born strong. Others swift. Others brilliant. And a fortunate few seem blessed by luck itself.", pause: 0 },
          { text: "The question is... Will you embrace the strengths fate has given you and become exceptional? Or will you stubbornly pursue a path for which you possess no natural talent, proving that determination can surpass destiny?", pause: 0 },
          { text: "Only time will tell.", pause: 0 },
          { text: "There is one more thing.", pause: 0 },
          { text: "Power in Emberhold is not earned only through victory—it is forged through repetition.", important: true, pause: 0 },
          { text: "Use a sword long enough, and your technique will sharpen.", pause: 0 },
          { text: "Cast the same spell often enough, and you'll uncover stronger versions of it.", pause: 0 },
          { text: "Experiment with different attacks, and you may discover entirely new combat techniques hidden from ordinary adventurers.", pause: 0 },
          { text: "No teacher knows every secret. Some techniques have never been written down. Perhaps... you'll be the first to discover them.", pause: 0 },
          { text: "Now then...", pause: 0 },
          { text: "What should I call you, world traveler?", isNamePrompt: true, pause: 0 },
          { text: "...A fine name.", pause: 0 },
          { text: "Before you set foot outside the town gates, a few words of advice.", pause: 0 },
          { text: "The local shop is more than a place to spend your hard-earned coins. Better weapons, sturdier armor, and a handful of supplies can mean the difference between returning home... or never returning at all.", pause: 0 },
          { text: "Do not underestimate training.", important: true, pause: 0 },
          { text: "Every swing of your blade, every spell you cast, every battle you survive leaves a mark upon you. The adventurers who become legends are rarely the ones born the strongest—they are the ones who never stop learning.", pause: 0 },
          { text: "And finally... The forest beyond Emberhold is no place for the careless.", pause: 0 },
          { text: "Even the humble Slime, mocked by seasoned adventurers as little more than a nuisance, is perfectly capable of ending the journey of someone unprepared.", pause: 0 },
          { text: "Overconfidence has filled more graves than monsters ever have.", important: true, pause: 0 },
          { text: "Remember this well. Death is permanent. There are no second chances.", important: true, pause: 0 },
          { text: "Be patient. Be prepared. And above all... Be cautious.", pause: 0 },
          { text: "Your story begins now.", important: true, pause: 0 },
        ],
        veteran: [
          { text: "...Hah. Thought so.", important: true, pause: 0 },
          { text: "Great — not this time. You already know what to be wary of.", pause: 0 },
          { text: "Good luck on your stats distribution!", important: true, pause: 0 },
          { text: "What should I call you, old soul?", isNamePrompt: true, pause: 0 },
          { text: "Right then. Your story begins now.", important: true, pause: 0 },
        ],
      };

      // The active script is assembled at runtime from the full intro + chosen branch.
      let NARRATOR_SCRIPT = [...NARRATOR_SCRIPT_FULL];

      let narratorIndex = 0;
      let narratorNameDone = false;
      let narratorWaitingForName = false;
      let narratorWaitingForChoice = false;

      // ---------------- Intro Music ----------------
      function playIntroMusic() {
        const audio = document.getElementById('intro-music');
        if (!audio) return;
        audio.volume = 0;
        audio.currentTime = 0;
        audio.play().catch(() => { }); // catch autoplay-blocked silently
        // Fade in over 2s
        let vol = 0;
        const fadeIn = setInterval(() => {
          vol = Math.min(1, vol + 0.05);
          audio.volume = vol;
          if (vol >= 1) clearInterval(fadeIn);
        }, 100);
      }

      function stopIntroMusic() {
        const audio = document.getElementById('intro-music');
        if (!audio || audio.paused) return;
        // Fade out over 1.5s then pause
        let vol = audio.volume;
        const fadeOut = setInterval(() => {
          vol = Math.max(0, vol - 0.067);
          audio.volume = vol;
          if (vol <= 0) { clearInterval(fadeOut); audio.pause(); audio.currentTime = 0; }
        }, 100);
      }

      function playTavernMusic() {
        const audio = document.getElementById('tavern-music');
        if (!audio) return;
        audio.volume = 0;
        audio.currentTime = 0;
        audio.play().catch(() => { });
        let vol = 0;
        const fadeIn = setInterval(() => {
          vol = Math.min(0.7, vol + 0.035); // slightly quieter than intro — feels like background ambience
          audio.volume = vol;
          if (vol >= 0.7) clearInterval(fadeIn);
        }, 100);
      }

      function stopTavernMusic() {
        const audio = document.getElementById('tavern-music');
        if (!audio || audio.paused) return;
        let vol = audio.volume;
        const fadeOut = setInterval(() => {
          vol = Math.max(0, vol - 0.05);
          audio.volume = vol;
          if (vol <= 0) { clearInterval(fadeOut); audio.pause(); audio.currentTime = 0; }
        }, 100);
      }

      function startNarrator() {
        // Create the character first so stats are ready
        state.player = createCharacter();
        state.potions = 3;
        state.mpPotions = 0;
        state.tomesPurchased = 0;
        state.slimesDefeated = 0;
        state.equip = { armour: null, weapon: null };
        state.quests = {
          veteran: { phase: 'intro', hiddenSameStrikes: 0, hiddenLastType: null, mainSameStrikes: 0, mainLastType: null, passiveStacks: 0 },
          slimeExtermination: { phase: 'available' }, // 'available' | 'active' | 'done' | 'claimed'
        };
        state.hasSave = true;
        state.currentScreen = 'narrator';
        state.equip = { armour: null, weapon: null };
        state.quests = {
          veteran: { phase: 'intro', hiddenSameStrikes: 0, hiddenLastType: null, mainSameStrikes: 0, mainLastType: null, passiveStacks: 0 },
          slimeExtermination: { phase: 'available', slimesKilled: 0, goal: 5 },
        };
        state.potions = 3;
        state.mpPotions = 0;
        state.tomesPurchased = 0;
        state.slimesDefeated = 0;
        state.burn = { turnsLeft: 0, damagePerTurn: 0 };
        state.combo = {
          lastSlash: null,
          crossProgress: 0,
          crossUnlocked: false,
          crossMastery: 0,
          crossSkillName: 'Cross Slash',
          risingProgress: 0,
          risingUnlocked: false,
          risingMastery: 0,
          risingSkillName: 'Rising Cross',
          equippedSkills: [],
        };
        state.isResting = false;
        state.inBattle = false;
        state.playerDefending = false;

        narratorIndex = 0;
        narratorNameDone = false;
        narratorWaitingForName = false;
        narratorWaitingForChoice = false;
        NARRATOR_SCRIPT = [...NARRATOR_SCRIPT_FULL]; // reset to opening lines only; branch appended on choice

        document.getElementById('narrator-toast-box').innerHTML = '';
        document.getElementById('screen-narrator').classList.add('active');
        playIntroMusic();
        showNarratorLine();
        saveGame();
      }

      function showNarratorLine() {
        if (narratorIndex >= NARRATOR_SCRIPT.length) {
          endNarrator();
          return;
        }
        const line = NARRATOR_SCRIPT[narratorIndex];
        const box = document.getElementById('narrator-toast-box');

        // Dim all previous toasts
        box.querySelectorAll('.narrator-toast:not(.dim)').forEach(t => t.classList.add('dim'));

        if (line.isChoicePrompt) {
          narratorWaitingForChoice = true;
          const el = document.createElement('div');
          el.className = 'narrator-toast narrator-important';
          el.innerHTML = `${line.text}
        <div class="narrator-choice-row">
          <button class="narrator-choice-btn" id="narrator-choice-yes">${line.yesLabel}</button>
          <button class="narrator-choice-btn" id="narrator-choice-no">${line.noLabel}</button>
        </div>`;
          box.appendChild(el);
          keepBoxScrolled(box);

          const choose = (key) => {
            // Append the chosen branch to the script starting at the current position + 1
            NARRATOR_SCRIPT = [...NARRATOR_SCRIPT.slice(0, narratorIndex + 1), ...NARRATOR_BRANCHES[key]];
            narratorWaitingForChoice = false;
            narratorIndex++;
            showNarratorLine();
          };
          document.getElementById('narrator-choice-yes').addEventListener('click', (e) => { e.stopPropagation(); choose(line.yesKey); });
          document.getElementById('narrator-choice-no').addEventListener('click', (e) => { e.stopPropagation(); choose(line.noKey); });
          return;
        }

        if (line.isNamePrompt) {
          narratorWaitingForName = true;
          const el = document.createElement('div');
          el.className = 'narrator-toast' + (line.important ? ' narrator-important' : '');
          el.innerHTML = `${line.text}
        <div class="narrator-name-row">
          <input class="narrator-name-input" id="narrator-name-input" maxlength="20" placeholder="Enter your name...">
          <button class="btn small" id="narrator-name-confirm" style="flex-shrink:0">Confirm</button>
        </div>`;
          box.appendChild(el);
          keepBoxScrolled(box);

          const confirm = () => {
            const val = document.getElementById('narrator-name-input').value.trim();
            if (!val) return;
            state.player.name = val;
            // Replace the next line with a personalised response
            if (NARRATOR_SCRIPT[narratorIndex + 1]) {
              const next = NARRATOR_SCRIPT[narratorIndex + 1];
              NARRATOR_SCRIPT[narratorIndex + 1] = { ...next, text: next.text.replace('A fine name', `${val}. A fine name`) };
            }
            narratorWaitingForName = false;
            narratorIndex++;
            showNarratorLine();
          };
          document.getElementById('narrator-name-confirm').addEventListener('click', confirm);
          document.getElementById('narrator-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
          return;
        }

        // Normal line
        const el = document.createElement('div');
        el.className = 'narrator-toast' + (line.important ? ' narrator-important' : '');
        el.textContent = line.text;
        // Prompt text
        const prompt = document.createElement('div');
        prompt.className = 'narrator-prompt';
        prompt.textContent = narratorIndex < NARRATOR_SCRIPT.length - 1 ? '— tap to continue —' : '— tap to begin —';
        el.appendChild(prompt);
        box.appendChild(el);
        keepBoxScrolled(box);
      }

      function keepBoxScrolled(box) {
        setTimeout(() => { box.scrollTop = box.scrollHeight; }, 20);
      }

      // Single-tap/click anywhere on the narrator screen advances the story.
      document.getElementById('screen-narrator').addEventListener('click', (e) => {
        if (narratorWaitingForName) return;
        if (narratorWaitingForChoice) return;
        if (e.target.closest('#narrator-name-confirm') || e.target.closest('#narrator-name-input')) return;
        if (e.target.closest('#narrator-choice-yes') || e.target.closest('#narrator-choice-no')) return;
        narratorIndex++;
        showNarratorLine();
      });

      function endNarrator() {
        document.getElementById('screen-narrator').classList.remove('active');
        stopIntroMusic();
        state.currentScreen = 'worldmap';
        document.getElementById('btn-continue').disabled = false;
        document.getElementById('save-hint').textContent = 'A new journey begins';
        console.log('Character created:', state.player);
        refreshWorldMap();
        showScreen('worldmap');
        saveGame();
        // Show onboarding on the very first visit
        startOnboarding();
      }

      // ---------------- Onboarding (first visit to world map) ----------------
      function startOnboarding() {
        const overlay = document.getElementById('onboarding-overlay');
        const panelTip = document.getElementById('ob-panels');
        const gift = document.getElementById('onboarding-gift');

        overlay.classList.add('active');
        panelTip.style.display = 'block';

        // Show the starting items gift message after a short delay
        setTimeout(() => {
          gift.textContent = '🎁 Starting gift: 50 Gold + 5 HP Potions';
          gift.classList.add('show');
        }, 800);
      }

      document.getElementById('onboarding-dismiss').addEventListener('click', () => {
        const overlay = document.getElementById('onboarding-overlay');
        overlay.classList.remove('active');
        document.getElementById('ob-panels').style.display = 'none';

        // Deliver starting items
        state.potions = 5;           // 5 HP potions (spec says 5, we init to 3 so override here)
        state.player.gold = 50;      // confirm the 50g
        refreshWorldMap();
        saveGame();
      });

      // ---------------- Inn Stories (during rest) ----------------
      // Stories are level-gated. Each entry has { text, maxLevel } — shown
      // only if player.level <= maxLevel (null = any level).
      const INN_STORIES = [
        // Lv 1-5: local colour, slimes, small tragedies
        { maxLevel: 5, text: '"Two silvers for a night, four if you want the bed with actual legs." — every inn in Emberhold, apparently.' },
        { maxLevel: 5, text: 'Merchant at the corner table: "Slimes near the town gate again. Third time this week. My boots are still sticky."' },
        { maxLevel: 5, text: 'Hushed voices by the fire: "Heard a party of five went into the old mine. Four came back. The fourth isn\'t talking much."' },
        { maxLevel: 5, text: '"The slimes are getting bolder," says the guard. "Yesterday one ate my sandwich. Whole. In one gulp." He stares into the distance.' },
        { maxLevel: 5, text: 'A young adventurer studying a crumpled map: "So this X means treasure, right? ...Right?"' },
        { maxLevel: 5, text: 'Overheard: "My swordsmanship trainer told me practice makes perfect. I\'ve been practicing. The slimes seem unimpressed."' },
        { maxLevel: 5, text: '"The dungeon on the hill? Oh it\'s perfectly safe," grins the merchant, not making eye contact.' },
        { maxLevel: 5, text: 'A courier arrives, breathless: "Lady Mirren requests adventurers for a simple escort quest." The table of veterans suddenly finds their drinks very interesting.' },
        { maxLevel: 5, text: '"Lost three good axes in there," says the dwarf, quietly. "The dungeon on the hill. Don\'t ask about the axes."' },
        { maxLevel: 5, text: 'Apprentice mage, reading loudly: "Chapter One: Fireballs and You. Step one: point away from face."' },
        { maxLevel: 5, text: '"Slimes," sighs the innkeeper, refilling your cup. "They\'re the start of everyone\'s story. Usually also the start of everyone\'s scar collection."' },
        { maxLevel: 5, text: 'Two adventurers settle a bar bet: "I told you Vertical Slash before Horizontal does something different!" The loser pays the tab.' },
      ];

      let innStoryTimers = [];

      function clearInnToasts() {
        innStoryTimers.forEach(t => clearTimeout(t));
        innStoryTimers = [];
        const box = document.getElementById('inn-toast-box');
        if (box) box.innerHTML = '';
      }

      function scheduleInnStories(durationSeconds) {
        clearInnToasts();

        const eligible = INN_STORIES.filter(s => !s.maxLevel || state.player.level <= s.maxLevel);
        if (!eligible.length || durationSeconds < 3) return;

        // Pick 1-3 stories to show across the rest duration
        const count = Math.min(3, Math.max(1, Math.floor(durationSeconds / 4)));
        const picks = eligible.sort(() => Math.random() - 0.5).slice(0, count);

        picks.forEach((story, i) => {
          // Spread them evenly but not right at 0 or at the very end
          const when = Math.round(durationSeconds * (i + 0.5) / count) * 1000;
          const t = setTimeout(() => spawnInnToast(story.text), when);
          innStoryTimers.push(t);
        });
      }

      function spawnInnToast(text) {
        const box = document.getElementById('inn-toast-box');
        if (!box) return;
        const el = document.createElement('div');
        el.className = 'inn-toast';
        el.textContent = text;
        box.appendChild(el);
        // Remove after a comfortable read time
        setTimeout(() => el.remove(), 7000);
      }

      // ---------------- World Map ----------------
      function refreshWorldMap() {
        if (!state.player) return;
        const p = state.player;

        // Player info bar
        setBar('wm-hp-fill', 'wm-hp-label', p.hp, p.maxHp, 'HP');
        setBar('wm-mp-fill', 'wm-mp-label', p.mp, p.maxMp, 'MP');
        setBar('wm-sp-fill', 'wm-sp-label', p.sp, p.maxSp, 'SP');
        refreshArmourSegment('wm-armour-seg', p.maxHp);

        // Character sheet modal
        document.getElementById('cs-level').textContent = p.level;
        document.getElementById('cs-exp').textContent = `${p.xp} / ${p.xpToNextLevel}`;
        document.getElementById('cs-gold').textContent = p.gold;
        document.getElementById('cs-sta').textContent = p.STA;
        document.getElementById('cs-str').textContent = p.STR;
        document.getElementById('cs-int').textContent = p.INT;
        document.getElementById('cs-dex').textContent = p.DEX;
        document.getElementById('cs-hp').textContent = `${p.hp}/${p.maxHp}`;
        document.getElementById('cs-mp').textContent = `${p.mp}/${p.maxMp}`;
        document.getElementById('cs-sp').textContent = `${p.sp}/${p.maxSp}`;
        document.getElementById('cs-sword-prof').textContent = p.swordsmanshipProficiency;
        document.getElementById('cs-body-prof').textContent = p.bodyProficiency;
        document.getElementById('cs-magic-prof').textContent = p.magicProficiency;
        document.getElementById('cs-crit').textContent = `${(p.DEX * 0.3).toFixed(1)}%`;

        // Inventory modal consumables
        document.getElementById('inv-hp-pot').textContent = state.potions;
        document.getElementById('inv-mp-pot').textContent = state.mpPotions;

        refreshPanelModals();
        refreshComboUI();
        saveGame();
      }

      // ---------------- Panel Modal System ----------------

      // All known skills with their metadata for the skill sheet and battle UI.
      function getSkillRegistry() {
        const c = state.combo;
        return [
          { id: 'vertical', name: 'Vertical Slash', unlocked: true, mastery: null, masteryMax: null, desc: 'Standard sword strike. Deals STR-based damage.' },
          { id: 'horizontal', name: 'Horizontal Slash', unlocked: true, mastery: null, masteryMax: null, desc: 'DEX-scaled swing with up to +50% crit bonus on high rolls.' },
          { id: 'fireball', name: 'Fireball', unlocked: true, mastery: c.crossMastery, masteryMax: null, desc: `INT-based spell. Burns for ${Math.max(1, Math.round(1 * 0.5))}+ dmg/turn × 3 turns.` },
          { id: 'cross', name: c.crossSkillName, unlocked: c.crossUnlocked, mastery: c.crossMastery, masteryMax: COMBO_MASTERY_EVOLVE_AT, desc: '200% sword dmg in one turn. Costs 2× SP.' },
          { id: 'rising', name: c.risingSkillName, unlocked: c.risingUnlocked, mastery: c.risingMastery, masteryMax: COMBO_MASTERY_EVOLVE_AT, desc: '180% rising sword strike. Costs 2× SP.' },
        ];
      }

      const MAX_EQUIPPED_SKILLS = 6;

      function refreshPanelModals() {
        refreshSkillModal();
        refreshInventoryModal();
      }

      function refreshSkillModal() {
        const skills = getSkillRegistry();
        const equipped = state.combo.equippedSkills;

        // Equipped skill slots (always 6 displayed)
        const slotsEl = document.getElementById('equipped-skill-slots');
        if (!slotsEl) return;
        slotsEl.innerHTML = '';
        for (let i = 0; i < MAX_EQUIPPED_SKILLS; i++) {
          const skillId = equipped[i] || null;
          const skill = skillId ? skills.find(s => s.id === skillId) : null;
          const div = document.createElement('div');
          div.className = 'skill-slot' + (skill ? ' equipped' : ' empty');
          div.textContent = skill ? skill.name : `—`;
          if (skill) {
            div.title = `Click to unequip ${skill.name}`;
            div.addEventListener('click', () => { unequipSkill(skillId); refreshSkillModal(); refreshBattleSkillBar(); });
          }
          slotsEl.appendChild(div);
        }

        // All sword technique cards
        const listEl = document.getElementById('skill-list-sword');
        if (!listEl) return;
        listEl.innerHTML = '';
        skills.forEach(skill => {
          const isEquipped = equipped.includes(skill.id);
          const card = document.createElement('div');
          card.className = 'tech-card' + (skill.unlocked ? '' : ' locked') + (isEquipped ? ' equipped' : '');

          let progressHTML = '';
          if (skill.mastery !== null && skill.masteryMax !== null) {
            const pct = Math.min(100, Math.round(skill.mastery / skill.masteryMax * 100));
            progressHTML = `
          <div class="tech-card-bar-track"><div class="tech-card-bar-fill" style="width:${pct}%"></div></div>`;
          } else if (!skill.unlocked) {
            const prog = skill.id === 'cross' ? state.combo.crossProgress : (skill.id === 'rising' ? state.combo.risingProgress : 0);
            const max = skill.id === 'cross' ? CROSS_COMBO_UNLOCK_AT : (skill.id === 'rising' ? RISING_COMBO_UNLOCK_AT : 0);
            if (max > 0) {
              progressHTML = `
          <div class="tech-card-bar-track"><div class="tech-card-bar-fill" style="width:${Math.round(prog / max * 100)}%;opacity:0.4"></div></div>`;
            }
          }

          const actionLabel = !skill.unlocked ? 'Locked' : isEquipped ? 'Unequip' : (equipped.length >= MAX_EQUIPPED_SKILLS ? 'Full' : 'Equip');
          const canAct = skill.unlocked && (isEquipped || equipped.length < MAX_EQUIPPED_SKILLS);

          card.innerHTML = `
        <div class="tech-card-header">
          <span class="tech-card-name">${skill.name}</span>
          <span class="tech-card-level">${skill.mastery !== null && skill.masteryMax !== null ? skill.mastery + '/' + skill.masteryMax : (skill.unlocked ? '✓' : '?')}</span>
        </div>
        ${progressHTML}
        <div class="tech-card-desc">${skill.desc}</div>
        <button style="margin-top:6px;font-size:0.7rem;padding:3px 8px;cursor:${canAct ? 'pointer' : 'not-allowed'};opacity:${canAct ? 1 : 0.4};font-family:Cinzel;border:1px solid var(--ink);border-radius:3px;background:var(--parchment);">
          ${actionLabel}
        </button>`;

          const btn = card.querySelector('button');
          if (canAct) btn.addEventListener('click', () => {
            if (isEquipped) unequipSkill(skill.id);
            else equipSkill(skill.id);
            refreshSkillModal();
            refreshBattleSkillBar();
          });
          listEl.appendChild(card);
        });
      }

      function refreshInventoryModal() {
        const invEl = document.getElementById('inv-equip-list');
        if (!invEl) return;
        invEl.innerHTML = '';

        const items = [
          { id: 'basic_armour_plate', name: 'Basic Armour Plate', icon: '🛡', slot: 'armour', stat: '+4 max HP', tip: 'A sturdy iron plate. Permanently increases max HP by 4, shown in brown on the HP bar.' },
          { id: 'bronze_sword', name: 'Bronze Sword', icon: '⚔', slot: 'weapon', stat: '+1 sword dmg', tip: 'A solid bronze blade. Adds +1 to all sword attack damage.' },
        ];

        let hasAny = false;
        items.forEach(item => {
          const owned = state.equip[item.slot] !== null || state.equip[item.slot] === item.id;
          // Only show items the player has actually purchased
          const purchased = state.equip[item.slot] === item.id || (item.slot === 'armour' && state.equip.armour) || (item.slot === 'weapon' && state.equip.weapon);
          const isThisEquipped = state.equip[item.slot] === item.id;
          if (!purchased) return;
          hasAny = true;
          const card = document.createElement('div');
          card.className = 'inv-card' + (isThisEquipped ? ' equipped' : '');
          const actionText = isThisEquipped ? 'Unequip' : 'Equip';
          card.innerHTML = `
        <div class="inv-card-tooltip">${item.tip}</div>
        <div class="inv-card-header">
          <span class="inv-card-name">${item.icon} ${item.name}</span>
          <span class="inv-card-tag ${isThisEquipped ? 'unequip' : ''}">${actionText}</span>
        </div>
        <div class="inv-card-stat">${item.stat}</div>`;
          card.addEventListener('click', () => {
            if (isThisEquipped) {
              state.equip[item.slot] = null;
              recalcMaxPools(state.player);
              state.player.hp = Math.min(state.player.hp, state.player.maxHp);
            } else {
              state.equip[item.slot] = item.id;
              recalcMaxPools(state.player);
              state.player.hp = state.player.maxHp;
            }
            refreshWorldMap();
          });
          invEl.appendChild(card);
        });

        if (!hasAny) invEl.innerHTML = '<div class="inv-empty">No equipment yet. Visit the Shop!</div>';
      }

      function equipSkill(id) {
        if (state.combo.equippedSkills.includes(id)) return;
        if (state.combo.equippedSkills.length >= MAX_EQUIPPED_SKILLS) return;
        state.combo.equippedSkills.push(id);
      }

      function unequipSkill(id) {
        state.combo.equippedSkills = state.combo.equippedSkills.filter(s => s !== id);
      }

      // Closes all modals and toggles the clicked one.
      function togglePanelModal(id) {
        const wasOpen = document.getElementById(id).classList.contains('open');
        document.querySelectorAll('.panel-modal').forEach(m => m.classList.remove('open'));
        document.querySelectorAll('.panel-btn').forEach(b => b.classList.remove('active'));
        if (!wasOpen) {
          document.getElementById(id).classList.add('open');
          document.getElementById('pbtn-' + id.replace('modal-', '')).classList.add('active');
        }
      }

      document.getElementById('pbtn-char').addEventListener('click', () => togglePanelModal('modal-char'));
      document.getElementById('pbtn-skills').addEventListener('click', () => { refreshSkillModal(); togglePanelModal('modal-skills'); });
      document.getElementById('pbtn-inv').addEventListener('click', () => { refreshInventoryModal(); togglePanelModal('modal-inv'); });

      document.querySelectorAll('.panel-modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById(btn.dataset.close).classList.remove('open');
          const key = btn.dataset.close.replace('modal-', '');
          const pbtn = document.getElementById('pbtn-' + key);
          if (pbtn) pbtn.classList.remove('active');
        });
      });

      // Rebuild the battle action bar to reflect the currently equipped skill set.
      // The 6 equipped slots map directly to the 6 icon-btn positions.
      // Called after skill equip/unequip and at battle start.
      function refreshBattleSkillBar() {
        // Currently the battle bar is still fixed-HTML; we just update visibility
        // of combo skill buttons based on equipped skills — this is a light version
        // of the "equip before battle" system. Full slot-mapping would need the
        // icon-btn HTML to be dynamic.
        const equipped = state.combo.equippedSkills;
        const crossBtn = document.getElementById('act-cross-slash');
        const risingBtn = document.getElementById('act-rising-cross');
        if (crossBtn) crossBtn.classList.toggle('hidden', !equipped.includes('cross') || !state.combo.crossUnlocked);
        if (risingBtn) risingBtn.classList.toggle('hidden', !equipped.includes('rising') || !state.combo.risingUnlocked);
      }

      // ---------------- Shop ----------------
      const HP_POTION_COST = 10;
      const MP_POTION_COST = 10;
      const MP_POTION_RESTORE = 5;
      const TOME_COST = 50;
      const TOME_LEVELUP_CHANCE = 0.01; // 1 in 100
      const ARMOUR_PLATE_COST = 30;
      const BRONZE_SWORD_COST = 30;

      // One Magic Tome purchase is allowed per 5-level bracket: Lv1-5 -> 1,
      // Lv6-10 -> 2, Lv11-15 -> 3, and so on.
      function tomePurchaseLimit(player) {
        return Math.ceil(player.level / 5);
      }

      function showShopMessage(message, isError) {
        const el = document.getElementById('shop-message');
        el.textContent = message;
        el.classList.toggle('error', !!isError);
      }

      function refreshShop() {
        if (!state.player) return;
        const p = state.player;
        const limit = tomePurchaseLimit(p);

        document.getElementById('shop-gold-amount').textContent = p.gold;
        document.getElementById('shop-hp-potion-count').textContent = state.potions;
        document.getElementById('shop-mp-potion-count').textContent = state.mpPotions;
        document.getElementById('shop-tome-count').textContent = state.tomesPurchased;
        document.getElementById('shop-tome-limit').textContent = limit;

        document.getElementById('shop-buy-hp-potion').disabled = p.gold < HP_POTION_COST;
        document.getElementById('shop-buy-mp-potion').disabled = p.gold < MP_POTION_COST;
        document.getElementById('shop-buy-tome').disabled = (p.gold < TOME_COST) || (state.tomesPurchased >= limit);

        const hasArmour = state.equip.armour === 'basic_armour_plate';
        document.getElementById('shop-armour-status').textContent = hasArmour ? '✓ Equipped' : 'Not equipped';
        document.getElementById('shop-buy-armour').textContent = hasArmour ? 'Owned' : 'Buy 30g';
        document.getElementById('shop-buy-armour').disabled = hasArmour || p.gold < ARMOUR_PLATE_COST;

        const hasWeapon = state.equip.weapon === 'bronze_sword';
        document.getElementById('shop-weapon-status').textContent = hasWeapon ? '✓ Equipped' : 'Not equipped';
        document.getElementById('shop-buy-weapon').textContent = hasWeapon ? 'Owned' : 'Buy 30g';
        document.getElementById('shop-buy-weapon').disabled = hasWeapon || p.gold < BRONZE_SWORD_COST;
        saveGame();
      }

      document.getElementById('shop-buy-hp-potion').addEventListener('click', () => {
        if (state.player.gold < HP_POTION_COST) { showShopMessage('Not enough gold.', true); return; }
        state.player.gold -= HP_POTION_COST;
        state.potions += 1;
        showShopMessage('Bought an HP Potion.');
        refreshShop();
        refreshWorldMap();
      });

      document.getElementById('shop-buy-mp-potion').addEventListener('click', () => {
        if (state.player.gold < MP_POTION_COST) { showShopMessage('Not enough gold.', true); return; }
        state.player.gold -= MP_POTION_COST;
        state.mpPotions += 1;
        showShopMessage('Bought an MP Potion.');
        refreshShop();
        refreshWorldMap();
      });

      document.getElementById('shop-buy-tome').addEventListener('click', () => {
        const limit = tomePurchaseLimit(state.player);
        if (state.tomesPurchased >= limit) {
          showShopMessage(`You've studied all the tomes you can absorb for now - come back at a higher level.`, true);
          return;
        }
        if (state.player.gold < TOME_COST) { showShopMessage('Not enough gold.', true); return; }

        state.player.gold -= TOME_COST;
        state.tomesPurchased += 1;
        state.player.INT += 1;

        let message = 'You study the Magic Tome. INT +1.';
        if (Math.random() < TOME_LEVELUP_CHANCE) {
          state.player.fireballCastsUsed += FIREBALL_SKILL_MILESTONE;
          message = 'The tome resonates with power! INT +1, and your Fireball mastery advances a level!';
        }
        showShopMessage(message);
        refreshShop();
        refreshWorldMap();
      });

      document.getElementById('shop-back').addEventListener('click', () => {
        refreshWorldMap();
        showScreen('worldmap');
      });

      document.getElementById('shop-buy-armour').addEventListener('click', () => {
        if (state.equip.armour === 'basic_armour_plate') { showShopMessage('Already equipped.', true); return; }
        if (state.player.gold < ARMOUR_PLATE_COST) { showShopMessage('Not enough gold.', true); return; }
        state.player.gold -= ARMOUR_PLATE_COST;
        state.equip.armour = 'basic_armour_plate';
        recalcMaxPools(state.player);             // maxHp now includes the +4
        state.player.hp = state.player.maxHp;    // top up HP to the new max on equip
        showShopMessage('Basic Armour Plate equipped! +4 max HP.');
        refreshShop();
        refreshWorldMap();
      });

      document.getElementById('shop-buy-weapon').addEventListener('click', () => {
        if (state.equip.weapon === 'bronze_sword') { showShopMessage('Already equipped.', true); return; }
        if (state.player.gold < BRONZE_SWORD_COST) { showShopMessage('Not enough gold.', true); return; }
        state.player.gold -= BRONZE_SWORD_COST;
        state.equip.weapon = 'bronze_sword';
        showShopMessage('Bronze Sword equipped! +1 to sword attack damage.');
        refreshShop();
        refreshWorldMap();
      });

      document.getElementById('node-adventure').addEventListener('click', () => {
        if (state.isResting) return;
        startBattle(false);
      });
      document.getElementById('node-training').addEventListener('click', () => {
        if (state.isResting) return;
        startBattle(true);
      });
      document.getElementById('node-shop').addEventListener('click', () => {
        if (state.isResting) return;
        document.getElementById('shop-message').textContent = '';
        document.getElementById('shop-message').classList.remove('error');
        refreshShop();
        showScreen('shop');
      });
      document.getElementById('node-guild').addEventListener('click', () => {
        if (state.isResting) return;
        openGuild();
      });
      document.getElementById('node-home').addEventListener('click', () => {
        if (state.isResting) return;
        const p = state.player;
        const missingHp = p.maxHp - p.hp;
        const missingMp = p.maxMp - p.mp;
        const missingSp = p.maxSp - p.sp;
        const totalMissing = missingHp + missingMp + missingSp;

        if (totalMissing <= 0) {
          flashRestLabel('Already at full strength');
          return;
        }

        startResting(totalMissing / 2); // duration in seconds = missing stats / 2
      });

      function setMapNodesEnabled(enabled) {
        document.getElementById('node-adventure').disabled = !enabled;
        document.getElementById('node-training').disabled = !enabled;
        document.getElementById('node-shop').disabled = !enabled;
        document.getElementById('node-guild').disabled = !enabled;
        document.getElementById('node-home').disabled = !enabled;
      }

      // Briefly swaps the rest button's label for a message, then restores it.
      function flashRestLabel(message) {
        const label = document.getElementById('rest-label');
        const original = label.textContent;
        label.textContent = message;
        setTimeout(() => { label.textContent = original; }, 1200);
      }

      // Runs the resting animation: a fill bar animates across the button over
      // durationSeconds while a text countdown ticks down once per second, then
      // the actual heal is applied once the duration elapses.
      function startResting(durationSeconds) {
        state.isResting = true;
        setMapNodesEnabled(false);
        scheduleInnStories(durationSeconds);
        playTavernMusic();

        const fill = document.getElementById('rest-progress-fill');
        const label = document.getElementById('rest-label');

        fill.style.transition = 'none';
        fill.style.width = '0%';
        void fill.offsetWidth; // force reflow so the transition below actually plays
        fill.style.transition = `width ${durationSeconds}s linear`;
        fill.style.width = '100%';

        let remaining = Math.ceil(durationSeconds);
        label.textContent = `Resting... ${remaining}s`;

        const tickTimer = setInterval(() => {
          remaining -= 1;
          if (remaining > 0) {
            label.textContent = `Resting... ${remaining}s`;
          } else {
            clearInterval(tickTimer);
          }
        }, 1000);

        setTimeout(() => {
          clearInterval(tickTimer);
          finishResting();
        }, durationSeconds * 1000);
      }

      function finishResting() {
        clearInnToasts();
        stopTavernMusic();
        state.player.hp = state.player.maxHp;
        state.player.mp = state.player.maxMp;
        state.player.sp = state.player.maxSp;
        refreshWorldMap();

        const fill = document.getElementById('rest-progress-fill');
        const label = document.getElementById('rest-label');
        fill.style.transition = 'none';
        fill.style.width = '0%';
        label.textContent = 'Rest / Recover';

        state.isResting = false;
        setMapNodesEnabled(true);
      }

      // ---------------- Battle ----------------
      function startBattle(isTraining) {
        state.enemy = isTraining ? createTrainingDummy(state.player.level) : createSlimeEncounter(state.player.level);
        state.inBattle = true;
        state.playerDefending = false;

        document.getElementById('e-name').textContent = state.enemy.name;
        document.getElementById('e-level').textContent = `LV ${state.enemy.level}`;
        document.getElementById('e-emblem').textContent = state.enemy.emblem;
        document.getElementById('arena-enemy-sprite').textContent = state.enemy.emblem;

        clearLog();
        log(isTraining ? `You step up to the training dummy.` : `A ${state.enemy.name} blocks your path!`);
        resetBattleTally();
        state.burn.turnsLeft = 0;
        state.burn.damagePerTurn = 0;
        state.combo.lastSlash = null; // reset sequence tracker each battle
        refreshBattleSkillBar();      // apply equipped-skill list to battle UI
        showBattleMenu('main'); // always start on the main menu

        document.getElementById('act-escape').textContent = isTraining ? 'Stop Training' : 'Escape';

        document.getElementById('result-banner').classList.remove('show');
        document.getElementById('battle-menu-wrapper').style.display = 'flex';

        refreshBattleUI();
        saveGame();
        showScreen('battle');
      }

      // Switches between the main action menu and the Sword / Item sub-menus.
      // which: 'main' | 'sword' | 'item'
      function showBattleMenu(which) {
        document.getElementById('battle-menu-main').classList.toggle('hidden', which !== 'main');
        document.getElementById('battle-menu-sword').classList.toggle('hidden', which !== 'sword');
        document.getElementById('battle-menu-item').classList.toggle('hidden', which !== 'item');
      }

      function refreshBattleUI() {
        if (!state.player || !state.enemy) return;
        const p = state.player, e = state.enemy;
        setBar('p-hp-fill', 'p-hp-label', p.hp, p.maxHp, 'HP');
        setBar('p-mp-fill', 'p-mp-label', p.mp, p.maxMp, 'MP');
        setBar('p-sp-fill', 'p-sp-label', p.sp, p.maxSp, 'SP');
        setBar('e-hp-fill', 'e-hp-label', e.hp, e.maxHp, 'HP');
        refreshArmourSegment('p-armour-seg', p.maxHp);

        const itemBtn = document.getElementById('act-item');
        itemBtn.title = `Item (${state.potions} HP, ${state.mpPotions} MP)`;
        itemBtn.disabled = (state.potions <= 0 && state.mpPotions <= 0);

        const hpPotionBtn = document.getElementById('act-use-hp-potion');
        hpPotionBtn.title = `HP Potion (${state.potions} left)`;
        hpPotionBtn.disabled = state.potions <= 0;

        const mpPotionBtn = document.getElementById('act-use-mp-potion');
        mpPotionBtn.title = `MP Potion (${state.mpPotions} left)`;
        mpPotionBtn.disabled = state.mpPotions <= 0;

        // Sword skill level and SP cost are frozen for the whole fight (same
        // "stats only update at battle end" rule as everything else), so this
        // just reflects whatever they were computed as when the fight started.
        const cost = swordSpCost(p);
        const skillLevel = swordSkillLevel(p);
        const notEnoughSp = p.sp < cost;
        const vSlashBtn = document.getElementById('act-vertical-slash');
        const hSlashBtn = document.getElementById('act-horizontal-slash');
        vSlashBtn.title = `Vertical Slash - Sword Lv ${skillLevel}, costs ${cost} SP`;
        hSlashBtn.title = `Horizontal Slash - Sword Lv ${skillLevel}, costs ${cost} SP`;
        vSlashBtn.disabled = notEnoughSp;
        hSlashBtn.disabled = notEnoughSp;

        // Same deal for Fireball, frozen for the fight and keyed off MP instead of SP.
        const fbCost = fireballMpCost(p);
        const fbSkillLevel = fireballSkillLevel(p);
        const magicBtn = document.getElementById('act-magic');
        magicBtn.title = `Fireball - Lv ${fbSkillLevel}, costs ${fbCost} MP`;
        magicBtn.disabled = p.mp < fbCost;
        saveGame();
      }

      function setBar(fillId, labelId, val, max, prefix) {
        const pct = Math.max(0, Math.round((val / max) * 100));
        document.getElementById(fillId).style.width = pct + '%';
        document.getElementById(labelId).textContent = `${prefix} ${Math.max(0, val)}/${max}`;
      }

      // Shows the brown armour-HP segment at the right edge of the HP bar.
      // Width = armour bonus / maxHp as a percentage of the bar track.
      function refreshArmourSegment(segId, maxHp) {
        const seg = document.getElementById(segId);
        if (!seg) return;
        const hasArmour = state.equip && state.equip.armour === 'basic_armour_plate';
        if (!hasArmour) { seg.classList.remove('visible'); return; }
        const pct = Math.min(100, Math.round((ARMOUR_PLATE_HP_BONUS / maxHp) * 100));
        seg.style.width = pct + '%';
        seg.classList.add('visible');
      }

      // ---------------- Battle Animations ----------------
      // Generic re-triggerable class player: removes the class, forces a reflow
      // so the browser will replay the animation even if it just played, adds
      // the class back, then cleans up after `duration`ms.
      function playAnim(el, className, duration) {
        if (!el) return;
        el.classList.remove(className);
        void el.offsetWidth; // force reflow
        el.classList.add(className);
        setTimeout(() => el.classList.remove(className), duration);
      }

      // Damage-taken reaction, shared by the player and enemy sprites.
      function playHitAnim(spriteId) {
        playAnim(document.getElementById(spriteId), 'anim-hit', 400);
      }

      // Vertical/Horizontal Slash: player lunges forward, a slash mark flashes
      // over the enemy, and the enemy's hit reaction plays right after impact.
      function playSlashAnim(orientation, isCrit) {
        playAnim(document.getElementById('arena-player-sprite'), 'anim-lunge', 320);

        const mark = document.getElementById('slash-mark');
        if (mark) {
          mark.classList.remove('play-v', 'play-h', 'crit');
          void mark.offsetWidth;
          mark.classList.toggle('crit', !!isCrit);
          mark.classList.add(orientation === 'vertical' ? 'play-v' : 'play-h');
          setTimeout(() => mark.classList.remove('play-v', 'play-h', 'crit'), 300);
        }

        setTimeout(() => playHitAnim('arena-enemy-sprite'), 150);
      }

      // Fireball: player glows while casting, a fireball travels across the
      // arena, and the enemy's hit reaction plays on impact.
      function playFireballAnim() {
        playAnim(document.getElementById('arena-player-sprite'), 'anim-cast', 400);

        const fireball = document.getElementById('fx-fireball');
        if (fireball) {
          fireball.classList.remove('play');
          void fireball.offsetWidth;
          fireball.classList.add('play');
          setTimeout(() => fireball.classList.remove('play'), 450);
        }

        setTimeout(() => playHitAnim('arena-enemy-sprite'), 400);
      }

      // Spawns a floating damage (red, 3.5s) or heal (green, 4.5s) number
      // anchored to the given fighter-slot element. Multiple floaters stack
      // naturally since each is a fresh element with an independent position.
      function spawnFloater(slotId, value, type) {
        const slot = document.getElementById(slotId);
        if (!slot) return;

        const el = document.createElement('div');
        el.className = `floater ${type}`;
        el.textContent = type === 'damage' ? `-${value}` : `+${value}`;

        // Small random horizontal jitter so stacked floaters don't perfectly overlap
        const jitter = (Math.random() - 0.5) * 30;
        el.style.left = `calc(50% + ${jitter}px)`;

        slot.appendChild(el);

        // Clean up after the animation finishes (longest is 4.5s heal)
        const duration = type === 'heal' ? 4500 : 3500;
        setTimeout(() => el.remove(), duration + 100);
      }

      function clearLog() {
        // Keep the ghost element clear; toasts auto-remove themselves
        const box = document.getElementById('battle-log');
        if (box) box.innerHTML = '';
        const toastBox = document.getElementById('battle-toast-box');
        if (toastBox) toastBox.innerHTML = '';
      }

      function log(msg) {
        const toastBox = document.getElementById('battle-toast-box');
        if (!toastBox) return;

        const toast = document.createElement('div');
        const isImportant = /critical|victory|defeated|evolved|unlocked|level up/i.test(msg);
        const isGood = /recover|heal|mastery|technique/i.test(msg) && !isImportant;
        toast.className = 'battle-toast' + (isImportant ? ' important' : '') + (isGood ? ' good' : '');
        toast.textContent = msg;
        toastBox.appendChild(toast);

        // Keep max 5 toasts visible at once — remove oldest
        while (toastBox.children.length > 5) toastBox.removeChild(toastBox.firstChild);

        // Auto-remove after animation (4s + tiny buffer)
        setTimeout(() => toast.remove(), 4100);
      }

      function rollDamage(attacker, defender) {
        const base = Math.max(1, attacker.atk - defender.def);
        const variance = Math.floor(Math.random() * 3) - 1; // -1..+1
        return Math.max(1, base + variance);
      }

      function setActionsEnabled(enabled) {
        document.querySelectorAll('#battle-menu-wrapper button').forEach(b => b.disabled = !enabled);
      }

      document.getElementById('act-sword').addEventListener('click', () => {
        if (!state.inBattle) return;
        showBattleMenu('sword');
      });

      document.getElementById('act-sword-back').addEventListener('click', () => {
        showBattleMenu('main');
      });

      document.getElementById('act-vertical-slash').addEventListener('click', () => {
        if (!state.inBattle) return;
        const cost = swordSpCost(state.player);
        if (state.player.sp < cost) return;

        spendSp(state.player, cost);
        battleTally.swordAttacks += 1;
        updateTallyUI();
        const rawDmg = swordAttackDamage(state.player);
        const crit = rollCrit(state.player);
        const dmg = Math.max(1, Math.round(rawDmg * crit.multiplier) - state.enemy.def);
        state.enemy.hp -= dmg;
        playSlashAnim('vertical', crit.isCrit);
        setTimeout(() => spawnFloater('slot-enemy', dmg, crit.isCrit ? 'crit' : 'damage'), 150);
        log(crit.isCrit
          ? `Critical hit! Vertical slash strikes for ${dmg} damage! (-${cost} SP)`
          : `You deliver a vertical slash for ${dmg} damage. (-${cost} SP)`);
        recordSlash('vertical');
        showBattleMenu('main');
        resolveTurn();
      });

      document.getElementById('act-horizontal-slash').addEventListener('click', () => {
        if (!state.inBattle) return;
        const cost = swordSpCost(state.player); // frozen for the whole fight, same as swordAttackDamage
        if (state.player.sp < cost) return; // button should already be disabled in this case

        spendSp(state.player, cost);
        battleTally.swordAttacks += 1;
        updateTallyUI();
        const result = horizontalSlashDamage(state.player); // uses swordAttacksUsed as of the START of this fight
        const dmg = Math.max(1, result.damage - state.enemy.def);
        state.enemy.hp -= dmg;
        playSlashAnim('horizontal', result.bonusPercent > 0);
        setTimeout(() => spawnFloater('slot-enemy', dmg, 'damage'), 150);
        if (result.bonusPercent > 0) {
          log(`Precise horizontal slash (roll ${result.roll})! +${Math.round(result.bonusPercent)}% dmg — ${dmg} damage. (-${cost} SP)`);
        } else {
          log(`You deliver a horizontal slash for ${dmg} damage. (-${cost} SP)`);
        }
        recordSlash('horizontal');
        showBattleMenu('main');
        resolveTurn();
      });

      document.getElementById('act-defend').addEventListener('click', () => {
        if (!state.inBattle) return;
        state.playerDefending = true;
        state.combo.lastSlash = null; // defending breaks the sequence
        log(`You raise your guard.`);
        resolveTurn();
      });

      // Cross Slash: one action, deals 200% of base sword damage (V+H combined),
      // counts as 2 sword swings for proficiency/mastery purposes, consumes 2× SP cost.
      document.getElementById('act-cross-slash').addEventListener('click', () => {
        if (!state.inBattle || !state.combo.crossUnlocked) return;
        const cost = swordSpCost(state.player) * 2; // two swings worth of SP
        if (state.player.sp < cost) { log(`Not enough SP for ${state.combo.crossSkillName}! (needs ${cost} SP)`); return; }

        spendSp(state.player, cost);
        battleTally.swordAttacks += 2;
        updateTallyUI();
        // 200% base sword damage: two hits each at 100%, totalling 2×, then one crit roll covers both
        const rawDmg = swordAttackDamage(state.player);
        const crit = rollCrit(state.player);
        const totalRaw = Math.round(rawDmg * 2 * crit.multiplier);
        const dmg = Math.max(1, totalRaw - state.enemy.def);
        state.enemy.hp -= dmg;
        playSlashAnim('vertical', crit.isCrit);
        setTimeout(() => { playSlashAnim('horizontal', false); spawnFloater('slot-enemy', dmg, crit.isCrit ? 'crit' : 'damage'); }, 200);
        log(crit.isCrit
          ? `⚔ Critical ${state.combo.crossSkillName}! Both hits connect for ${dmg} damage! (-${cost} SP)`
          : `⚔ ${state.combo.crossSkillName}! 200% strike hits for ${dmg} damage. (-${cost} SP)`);
        addComboMastery('cross');
        state.combo.lastSlash = null; // cross slash resets the sequence
        showBattleMenu('main');
        resolveTurn();
      });

      // Rising Cross: one action, deals 180% base sword damage (H+V with rising momentum bonus).
      // Slightly less than Cross Slash but hits first with horizontal so the DEX bonus can trigger.
      document.getElementById('act-rising-cross').addEventListener('click', () => {
        if (!state.inBattle || !state.combo.risingUnlocked) return;
        const cost = swordSpCost(state.player) * 2;
        if (state.player.sp < cost) { log(`Not enough SP for ${state.combo.risingSkillName}! (needs ${cost} SP)`); return; }

        spendSp(state.player, cost);
        battleTally.swordAttacks += 2;
        updateTallyUI();
        const rawDmg = swordAttackDamage(state.player);
        const crit = rollCrit(state.player);
        const totalRaw = Math.round(rawDmg * 1.8 * crit.multiplier); // 180%
        const dmg = Math.max(1, totalRaw - state.enemy.def);
        state.enemy.hp -= dmg;
        playSlashAnim('horizontal', crit.isCrit);
        setTimeout(() => { playSlashAnim('vertical', false); spawnFloater('slot-enemy', dmg, crit.isCrit ? 'crit' : 'damage'); }, 200);
        log(crit.isCrit
          ? `⚔ Critical ${state.combo.risingSkillName}! Rising strike connects for ${dmg} damage! (-${cost} SP)`
          : `⚔ ${state.combo.risingSkillName}! Rising 180% strike hits for ${dmg} damage. (-${cost} SP)`);
        addComboMastery('rising');
        state.combo.lastSlash = null;
        showBattleMenu('main');
        resolveTurn();
      });

      document.getElementById('act-magic').addEventListener('click', () => {
        if (!state.inBattle) return;
        const cost = fireballMpCost(state.player);
        if (state.player.mp < cost) return;

        spendMp(state.player, cost);
        battleTally.fireballCasts += 1;
        updateTallyUI();
        const rawDmg = fireballDamage(state.player);
        const crit = rollCrit(state.player);
        const dmg = Math.max(1, Math.round(rawDmg * crit.multiplier) - state.enemy.def);
        state.enemy.hp -= dmg;
        // Burn: 50% of the fireball's actual damage, minimum 1, for 3 turns.
        // Refreshes (overwrites) if fireball hits again before burn expires.
        state.burn.damagePerTurn = Math.max(1, Math.round(dmg * 0.5));
        state.burn.turnsLeft = 3;
        playFireballAnim();
        setTimeout(() => spawnFloater('slot-enemy', dmg, crit.isCrit ? 'crit' : 'damage'), 400);
        log(crit.isCrit
          ? `Critical hit! The Fireball erupts for ${dmg} damage and ignites the target! (-${cost} MP)`
          : `You hurl a Fireball for ${dmg} damage and ignite the target! (-${cost} MP)`);
        resolveTurn();
      });

      document.getElementById('act-item').addEventListener('click', () => {
        if (!state.inBattle) return;
        showBattleMenu('item');
      });

      document.getElementById('act-item-back').addEventListener('click', () => {
        showBattleMenu('main');
      });

      document.getElementById('act-use-hp-potion').addEventListener('click', () => {
        if (!state.inBattle || state.potions <= 0) return;
        state.potions -= 1;
        const heal = 12;
        state.player.hp = Math.min(state.player.maxHp, state.player.hp + heal);
        spawnFloater('slot-player', heal, 'heal');
        log(`You drink an HP Potion and recover ${heal} HP.`);
        showBattleMenu('main');
        resolveTurn();
      });

      document.getElementById('act-use-mp-potion').addEventListener('click', () => {
        if (!state.inBattle || state.mpPotions <= 0) return;
        state.mpPotions -= 1;
        const restore = MP_POTION_RESTORE;
        state.player.mp = Math.min(state.player.maxMp, state.player.mp + restore);
        spawnFloater('slot-player', restore, 'heal');
        log(`You drink an MP Potion and recover ${restore} MP.`);
        showBattleMenu('main');
        resolveTurn();
      });

      document.getElementById('act-escape').addEventListener('click', () => {
        if (!state.inBattle) return;

        if (state.enemy.isTrainingDummy) {
          // Stop Training: always works immediately, straight back to the map.
          log(`You stop training and head back.`);
          commitBattleTally();
          endBattle();
          return;
        }

        const success = Math.random() < 0.75;
        if (success) {
          log(`You break away and flee the battle.`);
          commitBattleTally(); // fold this fight's tally into permanent stats
          endBattle(null); // no result banner, straight back to map
          return;
        } else {
          log(`You fail to escape!`);
          enemyTurn();
        }
      });

      function resolveTurn() {
        refreshBattleUI();
        if (state.enemy.hp <= 0) {
          victory();
          return;
        }

        // Burn tick: applies at the end of the player's action, before the
        // enemy acts. Uses the same hit-shake and floater as regular damage
        // so it's visually readable but slightly delayed (300ms) to not
        // collide with whatever animation just played.
        if (state.burn.turnsLeft > 0) {
          const burnDmg = state.burn.damagePerTurn;
          state.enemy.hp -= burnDmg;
          state.burn.turnsLeft -= 1;
          setTimeout(() => {
            playHitAnim('arena-enemy-sprite');
            spawnFloater('slot-enemy', burnDmg, 'damage');
          }, 300);
          const remaining = state.burn.turnsLeft;
          log(`🔥 Burn deals ${burnDmg} damage. (${remaining} turn${remaining !== 1 ? 's' : ''} remaining)`);
          refreshBattleUI();
          if (state.enemy.hp <= 0) {
            setTimeout(() => victory(), 350); // slight delay so the floater is visible
            return;
          }
        }

        enemyTurn();
      }

      function enemyTurn() {
        if (state.enemy.hp <= 0) return;

        if (state.enemy.isTrainingDummy) {
          // The dummy never fights back.
          log(`The training dummy doesn't fight back.`);
          state.playerDefending = false;
          refreshBattleUI();
          return;
        }

        let dmg = rollDamage(state.enemy, state.player);
        if (state.playerDefending) {
          dmg = Math.max(1, Math.floor(dmg * 0.5));
        }
        state.player.hp -= dmg;          // current HP still drops live
        battleTally.damageTaken += dmg;  // maxHp formula only sees this at battle end
        updateTallyUI();
        playHitAnim('arena-player-sprite');
        spawnFloater('slot-player', dmg, 'damage');
        log(`${state.enemy.name} strikes you for ${dmg} damage.`);
        state.playerDefending = false;
        refreshBattleUI();

        if (state.player.hp <= 0) {
          defeat();
        }
      }

      function victory() {
        state.inBattle = false;
        commitBattleTally(); // fold this fight's tally into permanent stats
        const e = state.enemy;
        if (!e.isTrainingDummy) state.slimesDefeated += 1;

        // Slime Extermination quest: count kills when quest is active
        if (!e.isTrainingDummy && state.quests.slimeExtermination.phase === 'active') {
          const q = state.quests.slimeExtermination;
          q.slimesKilled += 1;
          if (q.slimesKilled >= q.goal) {
            q.phase = 'done';
            log('⚔ Quest complete: Slime Extermination! Return to the Guild to claim your reward.');
          }
        }
        state.player.xp += e.xp;
        state.player.gold += e.gold;
        log(`You have defeated the ${e.name}!`);

        let leveledUp = false;
        while (state.player.xp >= state.player.xpToNextLevel) {
          leveledUp = true;
          state.player.xp -= state.player.xpToNextLevel;
          state.player.level += 1;
          state.player.xpToNextLevel = Math.round(state.player.xpToNextLevel * XP_GROWTH_RATE);
        }
        if (leveledUp) {
          recalcMaxPools(state.player); // level feeds directly into the HP/MP/SP formulas
          state.player.hp = state.player.maxHp; // full heal on level up
          state.player.mp = state.player.maxMp;
          state.player.sp = state.player.maxSp;
        }

        document.getElementById('battle-menu-wrapper').style.display = 'none';
        const banner = document.getElementById('result-banner');
        banner.className = 'result-banner victory show';
        document.getElementById('result-title').textContent = e.isTrainingDummy ? 'Training Complete!' : 'Victory!';
        document.getElementById('result-sub').textContent =
          `+${e.xp} XP` + (e.gold > 0 ? `, +${e.gold} gold` : '') + (leveledUp ? ` — Level up! You are now level ${state.player.level}.` : '');
        document.getElementById('btn-keep-training').style.display = e.isTrainingDummy ? '' : 'none';
        refreshBattleUI();
      }

      function defeat() {
        state.inBattle = false;
        commitBattleTally(); // fold this fight's tally into permanent stats
        log(`You have fallen...`);
        // MVP-friendly: revive with partial HP rather than a full game-over screen
        state.player.hp = Math.max(1, Math.floor(state.player.maxHp * 0.4));

        document.getElementById('battle-menu-wrapper').style.display = 'none';
        const banner = document.getElementById('result-banner');
        banner.className = 'result-banner defeat show';
        document.getElementById('result-title').textContent = 'Defeated...';
        document.getElementById('result-sub').textContent =
          `You limp back to the Hearth to recover.`;
        refreshBattleUI();
      }

      function endBattle() {
        state.inBattle = false;
        refreshWorldMap();
        showScreen('worldmap');
      }

      document.getElementById('btn-return-map').addEventListener('click', endBattle);
      document.getElementById('btn-keep-training').addEventListener('click', () => {
        // Start a fresh training dummy fight without going through the world map
        startBattle(true);
      });

      window.addEventListener('beforeunload', saveGame);
      window.addEventListener('pagehide', saveGame);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveGame();
      });

      loadGame();
      updateContinueButton();
    })();
  