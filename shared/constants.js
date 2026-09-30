// Game constants shared by the server (simulation) and the browser (rendering).
// Works both as a Node module and as a plain <script> (exposes window.SHARED).
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const WORLD_W = 4000, WORLD_H = 2600;          // ~4x a typical screen
  const QUEEN_R = 13, WORKER_R = 5, FOOD_R = 3.5;
  const PLAYER_SPEED = 220;
  const AI_SPEED = 185, AI_FLEE_SPEED = 180;
  const PLAYER_GRACE = 20, SPAWN_GRACE = 10;   // seconds new colonies are ignored by AI hunters
  const WORKER_SPEED = 270, CHARGE_SPEED = 380;
  const CHARGE_TIME = 2, PLAYER_CHARGE_CD = 1, AI_CHARGE_CD = 3;
  const RING0 = 36, RING_GAP = 11, RING_SPACING = 10.5;   // guard ring layout around the queen
  const FOOD_MAX = 420, FOOD_RESPAWN_RATE = 9;   // crumbs per second while below max
  const FOOD_PER_WORKER = 3, MAX_WORKERS = 400;
  const START_ENEMIES = 8, MAX_ENEMIES = 16;
  const PLAYER_COLOR = '#f5c542';
  const SKINS = [
    // basic ants: available from the start
    { id: 'gold',    name: 'Golden',    color: '#f5c542', glow: '255,220,90', basic: true },
    { id: 'fire',    name: 'Fire Ant',  color: '#ff5a26', glow: '255,110,40', head: '#8a1a05', embers: true, basic: true },
    { id: 'black',   name: 'Black Ant', color: '#2e2e34', glow: '200,200,220', head: '#18181c', basic: true },
    { id: 'brown',   name: 'Carpenter', color: '#8b5a2b', glow: '220,160,100', head: '#4f2f12', basic: true },
    { id: 'green',   name: 'Green Ant', color: '#6cbf3c', glow: '160,240,110', head: '#3f7d1e', basic: true },
    { id: 'blue',    name: 'Blue Ant',  color: '#3d86e0', glow: '120,180,255', head: '#1f4e8f', basic: true },
    // unlocked by achievements
    { id: 'bee',     name: 'Bumblebee', color: '#ffd21f', glow: '255,215,60', stripes: '#1b1408', workerWings: true },
    { id: 'lady',    name: 'Ladybug',   color: '#e0282e', glow: '255,90,90', head: '#15100c', spots: '#15100c' },
    { id: 'ghost',   name: 'Ghost',     color: '#d4ecff', glow: '170,220,255', alpha: 0.55, workerWings: true },
    { id: 'rainbow', name: 'Rainbow',   color: '#ff66cc', glow: '255,160,230', rainbow: true },
    { id: 'leaf',    name: 'Leafcutter', color: '#b5652a', glow: '150,220,90', head: '#5a2c10', leaf: true },
    { id: 'frost',   name: 'Frost',     color: '#9fd8ff', glow: '190,235,255', head: '#eaf8ff', stars: '#ffffff' },
    { id: 'galaxy',  name: 'Galaxy',    color: '#3b1f78', glow: '150,110,255', head: '#1c0f3e', stars: '#fff6b0' },
    { id: 'robot',   name: 'Robot',     color: '#a3adb7', glow: '120,230,255', head: '#56606a', stripes: '#5f6973', visor: '#3ff0ff' },
    { id: 'lava',    name: 'Lava',      color: '#2d1a14', glow: '255,120,30', head: '#1a0d08', cracks: '#ff8a1e' },
    { id: 'candy',   name: 'Candy',     color: '#ff8fc4', glow: '255,170,210', stripes: '#ffffff' },
    { id: 'royal',   name: 'Royal',     color: '#7b3fbf', glow: '190,130,255', head: '#3a1a66', stripes: '#ffd54a' },
    { id: 'diamond', name: 'Diamond',   color: '#bff4ff', glow: '200,250,255', head: '#f2feff', stars: '#ffffff', alpha: 0.8 },
    { id: 'emperor', name: 'Emperor',   color: '#1d1d24', glow: '255,210,80', head: '#0d0d10', stripes: '#ffd54a', visor: '#ffd54a' },
    { id: 'legend',  name: 'Legend',    color: '#ffcf3a', glow: '255,230,120', head: '#fff2a8', stars: '#ffffff', embers: true, workerWings: true },
    // other bug colonies
    { id: 'army',    name: 'Army Ant',  color: '#7a2a18', glow: '255,110,80', head: '#3a120a', mandibles: true },
    { id: 'termite', name: 'Termite',   body: 'termite', color: '#efe0c0', glow: '255,235,190', head: '#c07a35' },
    { id: 'wasp',    name: 'Wasp',      body: 'wasp', color: '#ffd21f', glow: '255,220,60', stripes: '#15110a', head: '#2a1e08' },
    { id: 'hornet',  name: 'Hornet',    body: 'wasp', color: '#e0801c', glow: '255,160,60', stripes: '#3a1a08', head: '#f2c230' },
    { id: 'moth',    name: 'Moth',      body: 'wasp', stinger: false, color: '#b9a58a', glow: '230,210,170', head: '#8a765c', mothWings: 'rgba(214,196,164,0.9)' },
    { id: 'scarab',  name: 'Scarab',    body: 'beetle', color: '#1f8a7a', glow: '90,230,200', head: '#0f4a42', stars: '#8ff5e0' },
    { id: 'jewel',   name: 'Jewel Beetle', body: 'beetle', color: '#28a86a', glow: '120,240,150', head: '#15603a', stripes: '#e0b83a' },
    { id: 'stag',    name: 'Stag Beetle', body: 'beetle', color: '#4a2a18', glow: '200,140,90', head: '#2a160c', horns: true },
    { id: 'firefly', name: 'Firefly',   body: 'beetle', color: '#3c3c2c', glow: '230,255,110', head: '#d05030', glowTail: true },
    { id: 'spider',  name: 'Spider',    body: 'spider', color: '#6a5a4a', glow: '200,170,140', head: '#3a2e24', spots: '#3a2e24' },
    { id: 'widow',   name: 'Black Widow', body: 'spider', color: '#1a1a1e', glow: '255,80,90', head: '#0c0c0e', hourglass: '#e0202a' },
    { id: 'roach',   name: 'Cockroach', body: 'roach', color: '#7a4520', glow: '220,150,90', head: '#3a200c', rim: '#d09a5a' },
  ];
  const SEP_DIST = 10, FIGHT_DIST = 10;
  const CELL = 40;
  const POWERUP_MAX = 5, FRENZY_TIME = 10, RUSH_TIME = 8, RUSH_SPEED = 1.35, FRENZY_POWER = 1.5;
  const GARDEN_R = 75, GARDEN_RATE = 1.0, HOLE_R = 18, TUNNEL_CD = 12;
  const POWER_INFO = {
    frenzy: { name: 'Fire Chili', color: '#ff4a3d', glow: 'rgba(255,80,60,', msg: 'Fire Chili! Your ants fight harder' },
    rush:   { name: 'Sugar Rush',  color: '#4fc8ff', glow: 'rgba(80,200,255,', msg: 'Sugar Rush! Faster queen, charge ready' },
  };
  const TUNNEL_COLORS = ['#c9a0ff', '#8fe0c8', '#ffb870'];
  const GCOLS = Math.ceil(WORLD_W / CELL), GROWS = Math.ceil(WORLD_H / CELL);
  const PALETTE = [
    { name: 'Crimson Hive',   color: '#e0403a' },
    { name: 'Azure Nest',     color: '#3d8fe0' },
    { name: 'Violet Mound',   color: '#9b59d0' },
    { name: 'Cyan Burrow',    color: '#2ec4d6' },
    { name: 'Ember Brood',    color: '#ff7a2e' },
    { name: 'Rose Swarm',     color: '#f062a8' },
    { name: 'Ivory Legion',   color: '#ece4d6' },
    { name: 'Obsidian Horde', color: '#26262b' },
    { name: 'Indigo Den',     color: '#5b5fd6' },
    { name: 'Slate Clan',     color: '#8fa3b3' },
    { name: 'Scarlet Tunnel', color: '#a8102a' },
    { name: 'Teal Dynasty',   color: '#1f9e8f' },
  ];
  const STREAK_WINDOW = 6;
  const STREAK_NAMES = ['', '', 'Double Conquest!', 'Triple Conquest!', 'Rampage!', 'Unstoppable!'];
  const MILESTONES = [
    { at: 25,  title: '25 ANTS!',  perk: 'Your crown grows' },
    { at: 50,  title: '50 ANTS!',  perk: 'Jewels set in your crown' },
    { at: 100, title: '100 ANTS!', perk: 'A royal aura surrounds your queen' },
    { at: 200, title: '200 ANTS!', perk: 'Your crown blazes with gold' },
  ];
  const RAIN_TIME = 20, RAIN_SLOW = 0.78, PUDDLE_SLOW = 0.55;
  const DIFFS = {
    easy:      { name: 'Easy',      aggro: 0.7,  strike: 1.9, react: 1.4, spawn: 1.5, startSize: 0.7, grace: 30, xp: 0.75, speed: 0.95,
                 hint: 'Calmer rivals, fewer spawns, 30s protection. XP x0.75' },
    normal:    { name: 'Normal',    aggro: 1,    strike: 1.5, react: 1,   spawn: 1,   startSize: 1,   grace: 20, xp: 1,    speed: 1,
                 hint: 'The standard challenge. XP x1' },
    nightmare: { name: 'Nightmare', aggro: 1.35, strike: 1.1, react: 0.6, spawn: 0.6, startSize: 1.4, grace: 10, xp: 1.6,  speed: 1.06,
                 hint: 'Ruthless, fast rivals everywhere. XP x1.6 and exclusive achievements' },
  };
  const STRIKE_RANGE = 340;   // how far an AI will launch a charge from (charge covers ~760px)
  const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  const EVENT_TYPES = ['rain', 'picnic', 'quake', 'flight', 'glass', 'flood', 'migration', 'night', 'blood', 'sugar', 'golden'];
  // snapshot / networking
  const NET = { TICK_HZ: 60, SNAP_HZ: 30, MAX_HUMANS: 12, VIEW_MARGIN: 160 };

  const SHARED = { TAU, WORLD_W, WORLD_H, QUEEN_R, WORKER_R, FOOD_R, PLAYER_SPEED, AI_SPEED, AI_FLEE_SPEED, PLAYER_GRACE, SPAWN_GRACE, WORKER_SPEED, CHARGE_SPEED, CHARGE_TIME, PLAYER_CHARGE_CD, AI_CHARGE_CD, RING0, RING_GAP, RING_SPACING, FOOD_MAX, FOOD_RESPAWN_RATE, FOOD_PER_WORKER, MAX_WORKERS, START_ENEMIES, MAX_ENEMIES, PLAYER_COLOR, SKINS, SEP_DIST, FIGHT_DIST, CELL, POWERUP_MAX, FRENZY_TIME, RUSH_TIME, RUSH_SPEED, FRENZY_POWER, GARDEN_R, GARDEN_RATE, HOLE_R, TUNNEL_CD, POWER_INFO, TUNNEL_COLORS, GCOLS, GROWS, PALETTE, STREAK_WINDOW, STREAK_NAMES, MILESTONES, RAIN_TIME, RAIN_SLOW, PUDDLE_SLOW, DIFFS, STRIKE_RANGE, COMPASS, EVENT_TYPES, NET };
  if (typeof module !== 'undefined' && module.exports) module.exports = SHARED;
  else root.SHARED = SHARED;
})(typeof self !== 'undefined' ? self : this);
