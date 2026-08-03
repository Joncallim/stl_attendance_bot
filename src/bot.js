import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import cron from "node-cron";
import { Markup, Telegraf, session } from "telegraf";
import { ipv4HttpsAgent } from "./network.js";
import {
  applyAttendanceEntriesToSnapshotBundle,
  addAppointmentToSheets,
  buildQueuedAttendanceEventMetadata,
  classifyAppointmentDepartment,
  isChiefAppointment,
  clearAllSheetProtections,
  createGoogleSheetsClient,
  runStartupSheetCleanup,
  DEPARTMENT_BUCKETS,
  ensureNextMonthSheetExists,
  getLastStructuralMaintenanceAt,
  getLastStructuralMaintenanceAttemptAt,
  loadAttendanceSnapshotsFromLocalCache,
  preloadAttendanceSnapshots,
  reconcilePendingAttendanceWithSheets,
  removeAppointmentFromSheets,
  runDailySheetMaintenance,
  summarizeAttendanceOptionUsage,
  syncOnboardingCodeColumn,
  syncOnboardingRoster,
  summarizeStatuses,
  summarizeStatusesFromSnapshot,
  isSnapshotRefreshDeferredError,
  transferAttendanceRows,
  writeAttendanceStatuses
} from "./googleSheets.js";
import {
  ATTENDANCE_QUEUE_FLUSH_INTERVAL_MS,
  ATTENDANCE_QUEUE_FLUSH_THRESHOLD,
  compactAttendanceQueue,
  enqueueAttendanceEvent,
  enqueueAttendanceEvents,
  getAttendanceQueueStatus,
  listPendingAttendanceEvents,
  listUnresolvedAttendanceEvents,
  flushAttendanceQueue,
  resetConflictedQueueEntries
} from "./attendanceQueue.js";
import { getSingaporePublicHolidaySet } from "./holidays.js";
import {
  addAdminAppointment,
  addAppointmentToRegistry,
  batchUpdateUsersByChatId,
  bindAppointmentCode,
  deregisterAppointmentBinding,
  deregisterRequestorByChatId,
  getAppointmentRegistry,
  getAppointmentBindingIdentity,
  getAppointmentStateIdentity,
  getSettings,
  getUserByChatId,
  getOnboardingInvite,
  listAdminAppointments,
  listUsers,
  removeAppointmentFromRegistry,
  recoverStorageTransactions,
  resetAttendanceOptions,
  removeAdminAppointment,
  setAttendanceOptionUsage,
  setAttendanceOptions,
  syncAppointmentRegistry,
  transferAppointmentBinding,
  updateUserByChatId,
  upsertUser
} from "./storage.js";
import {
  beginInteraction,
  beginTextInput,
  cancelInteractions,
  consumeInteraction,
  consumeTextInput,
  getInteraction,
  getTextInput
} from "./telegramInteractions.js";
import { createSyncManager } from "./syncManager.js";
import { writePrivateTextFile } from "./fileStore.js";
import {
  beginAttendanceTransferJournal,
  clearAttendanceTransferJournal,
  getAttendanceTransferJournal,
  updateAttendanceTransferJournal
} from "./attendanceTransferJournal.js";
import { applyStoredConfigOverrides } from "./config.js";
import { allSettledConcurrent, TELEGRAM_SEND_CONCURRENCY, TELEGRAM_SEND_INTERVAL_MS } from "./concurrency.js";
import {
  runAsNonessentialSnapshotRefresh,
  enqueueAttendancePromptBroadcast,
  shouldDeferSnapshotRefresh
} from "./broadcastActivity.js";
import {
  cancelAttendanceButtonCleanup,
  cleanupExpiredAttendanceButtons,
  scheduleAttendanceButtonCleanup
} from "./messageCleanup.js";
import {
  applyWeeklyAttendanceSelection,
  createWeeklyFlowState,
  getStagedAttendanceStatus,
  resolveWeeklyAttendanceEntries,
  upsertWeeklyAttendanceEntry
} from "./weeklyFlow.js";
import {
  getCurrentWorkPriority,
  requireBackgroundSheetProgress,
  runWithBackgroundPriority,
  runWithInteractivePriority,
  waitForInteractiveIdle
} from "./workPriority.js";

const ONBOARDING_CODE_PROMPT = "Send the secret code assigned to your appointment.";
export const BOT_VERSION = "v0.9.24";

function logBot(message, details = null) {
  const ts = new Date().toISOString();
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[${ts}] [Bot] ${message}${suffix}`);
}

function logBotWarn(message, details = null) {
  const ts = new Date().toISOString();
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.warn(`[${ts}] [Bot] ${message}${suffix}`);
}

function logBotError(message, details = null) {
  const ts = new Date().toISOString();
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.error(`[${ts}] [Bot] ${message}${suffix}`);
}

const WEEK_SKIP_LABEL = "Skip Day";
const MAX_TRACKED_ATTENDANCE_PROMPTS = 8;
const DEPARTMENT_MEMBER_PAGE_SIZE = 6;
const DEPARTMENT_WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const ATTENDANCE_OPTION_DISPLAY_ORDER = [
  "PRESENT",
  "DUTY",
  "PH",
  "OSD",
  "OE",
  "WFH",
  "FISHING",
  "OIL",
  "EMBARK OFF",
  "OFF",
  "DISEMBARK OFF",
  "RR",
  "SR",
  "OS",
  "TNB",
  "YARD",
  "ORCA",
  "RSO",
  "MC",
  "OML",
  "MA",
  "HL",
  "RSI",
  "LL",
  "CCL",
  "CSL",
  "COMPASSIONATE",
  "PTL",
  "OL",
  "AO",
  "68",
  "69",
  "70",
  "71",
  "73",
  "OC",
  "ORD",
  "POST OUT",
  "IPPT",
  "FMSS",
  "CNB",
  "CST",
  "DCTC"
];
const ATTENDANCE_OPTION_DESCRIPTIONS = {
  SR: "Sunday Routine",
  PH: "Public Holiday",
  OE: "Outside Event",
  OC: "On Course",
  OL: "Overseas Leave",
  AO: "Attached Out",
  LL: "Local Leave",
  MC: "Medical Certificate",
  OSD: "Overseas Duty",
  OS: "Outstationed",
  RSO: "Report Sick Outside",
  CST: "CST/NTT",
  OML: "Other Medical Leave",
  CCL: "Child Care Leave",
  MA: "Medical Appointment",
  TNB: "Tuas Naval Base",
  HL: "Hospitalisation Leave",
  OIL: "Off in Lieu",
  CNB: "Changi Naval Base",
  PTL: "Paternity Leave",
  RR: "Reverse Routine",
  RSI: "Report Sick In-Camp",
  WFH: "Work from Home"
};
const INSPIRATIONAL_QUOTES = [
  "The secret of getting ahead is getting started. — Mark Twain",
  "Well begun is half done. — Aristotle",
  "Action is the foundational key to all success. — Pablo Picasso",
  "What you do today can improve all your tomorrows. — Ralph Marston",
  "Start where you are. Use what you have. Do what you can. — Arthur Ashe",
  "It always seems impossible until it is done. — Nelson Mandela",
  "Do the hard jobs first. The easy jobs will take care of themselves. — Dale Carnegie",
  "The way to get started is to quit talking and begin doing. — Walt Disney",
  "Do one thing every day that scares you. — Eleanor Roosevelt",
  "Success is the sum of small efforts repeated day in and day out. — Robert Collier",
  "Small deeds done are better than great deeds planned. — Peter Marshall",
  "Dream big and dare to fail. — Norman Vaughan",
  "Turn your wounds into wisdom. — Oprah Winfrey",
  "If opportunity doesn’t knock, build a door. — Milton Berle",
  "The future depends on what you do today. — Mahatma Gandhi",
  "The best way out is always through. — Robert Frost",
  "Fall seven times and stand up eight. — Japanese Proverb",
  "You miss 100 percent of the shots you don’t take. — Wayne Gretzky",
  "The only way to do great work is to love what you do. — Steve Jobs",
  "Done is better than perfect. — Sheryl Sandberg",
  "Make each day your masterpiece. — John Wooden",
  "Do not wait to strike till the iron is hot; make it hot by striking. — William Butler Yeats",
  "One day or day one. You decide. — Paulo Coelho",
  "Keep going. Be all in. — Bryan Hutchinson",
  "Nothing will work unless you do. — Maya Angelou",
  "Energy and persistence conquer all things. — Benjamin Franklin",
  "He who has a why to live can bear almost any how. — Friedrich Nietzsche",
  "The man who moves a mountain begins by carrying away small stones. — Confucius",
  "The only limit to our realization of tomorrow is our doubts of today. — Franklin D. Roosevelt",
  "Perseverance is not a long race; it is many short races one after the other. — Walter Elliot",
  "The harder you work for something, the greater you’ll feel when you achieve it. — Anonymous",
  "If you want to lift yourself up, lift up someone else. — Booker T. Washington",
  "The most effective way to do it is to do it. — Amelia Earhart",
  "A river cuts through rock not because of its power, but because of its persistence. — James N. Watkins",
  "Ambition is the path to success. Persistence is the vehicle you arrive in. — Bill Bradley",
  "I never dreamed about success. I worked for it. — Estee Lauder",
  "We become what we think about most of the time. — Earl Nightingale",
  "Light tomorrow with today. — Elizabeth Barrett Browning",
  "You are never too old to set another goal or to dream a new dream. — C. S. Lewis",
  "Success usually comes to those who are too busy to be looking for it. — Henry David Thoreau",
  "The only place where success comes before work is in the dictionary. — Vidal Sassoon",
  "Quality is not an act, it is a habit. — Aristotle",
  "The expert in anything was once a beginner. — Helen Hayes",
  "There is no substitute for hard work. — Thomas Edison",
  "Be so good they can’t ignore you. — Steve Martin",
  "If you can dream it, you can do it. — Walt Disney",
  "Keep your face always toward the sunshine and shadows will fall behind you. — Walt Whitman",
  "The journey of a thousand miles begins with one step. — Lao Tzu",
  "Act as if what you do makes a difference. It does. — William James",
  "Believe you can and you’re halfway there. — Theodore Roosevelt",
  "The best preparation for tomorrow is doing your best today. — H. Jackson Brown Jr.",
  "Do what you can, with what you have, where you are. — Theodore Roosevelt",
  "Opportunities don’t happen. You create them. — Chris Grosser",
  "Try not to become a man of success, but rather become a man of value. — Albert Einstein",
  "Motivation gets you going, but discipline keeps you growing. — John C. Maxwell",
  "The difference between ordinary and extraordinary is that little extra. — Jimmy Johnson",
  "Hardships often prepare ordinary people for an extraordinary destiny. — C. S. Lewis",
  "A little progress each day adds up to big results. — Satya Nani",
  "Success isn’t always about greatness. It’s about consistency. — Dwayne Johnson",
  "You don’t have to be great to start, but you have to start to be great. — Zig Ziglar",
  "Be faithful in small things because it is in them that your strength lies. — Mother Teresa",
  "The only person you are destined to become is the person you decide to be. — Ralph Waldo Emerson",
  "Go as far as you can see; when you get there, you’ll be able to see further. — Thomas Carlyle",
  "Discipline is choosing between what you want now and what you want most. — Abraham Lincoln",
  "The successful warrior is the average man, with laser-like focus. — Bruce Lee",
  "Knowing is not enough; we must apply. Willing is not enough; we must do. — Johann Wolfgang von Goethe",
  "The sun himself is weak when he first rises, and gathers strength and courage as the day gets on. — Charles Dickens",
  "Don’t count the days, make the days count. — Muhammad Ali",
  "Never confuse a single defeat with a final defeat. — F. Scott Fitzgerald",
  "Great acts are made up of small deeds. — Lao Tzu",
  "You become what you believe. — Oprah Winfrey",
  "Begin anywhere. — John Cage",
  "The only journey is the one within. — Rainer Maria Rilke",
  "Courage is grace under pressure. — Ernest Hemingway",
  "Keep a little fire burning; however small, however hidden. — Cormac McCarthy",
  "The beginning is the most important part of the work. — Plato",
  "To improve is to change; to be perfect is to change often. — Winston Churchill",
  "If there is no struggle, there is no progress. — Frederick Douglass",
  "Go the extra mile. It’s never crowded. — Wayne Dyer",
  "A goal without a plan is just a wish. — Antoine de Saint-Exupery",
  "If you’re going through hell, keep going. — Winston Churchill",
  "Keep your eyes on the stars and your feet on the ground. — Theodore Roosevelt",
  "Whatever you are, be a good one. — Abraham Lincoln",
  "The best revenge is massive success. — Frank Sinatra",
  "Great things are done by a series of small things brought together. — Vincent van Gogh",
  "Work hard in silence, let success make the noise. — Frank Ocean",
  "When you have a dream, you’ve got to grab it and never let go. — Carol Burnett",
  "If you can’t do great things, do small things in a great way. — Napoleon Hill",
  "The key is not to prioritize what’s on your schedule, but to schedule your priorities. — Stephen Covey",
  "Never, never, never give up. — Winston Churchill",
  "If you want something you never had, you must be willing to do something you’ve never done. — Thomas Jefferson",
  "Patience, persistence and perspiration make an unbeatable combination for success. — Napoleon Hill",
  "The distance between insanity and genius is measured only by success. — Bruce Feirstein",
  "Strength does not come from physical capacity. It comes from an indomitable will. — Mahatma Gandhi",
  "The purpose of our lives is to be happy. — Dalai Lama",
  "Learn as if you will live forever, live like you will die tomorrow. — Mahatma Gandhi",
  "Everything you’ve ever wanted is on the other side of fear. — George Addair",
  "Don’t watch the clock; do what it does. Keep going. — Sam Levenson",
  "There are no shortcuts to any place worth going. — Beverly Sills",
  "Fortune sides with him who dares. — Virgil",
  "If we are strong, our strength will speak for itself. If we are weak, words will be of no help. — John F. Kennedy",
  "Your big opportunity may be right where you are now. — Napoleon Hill",
  "Failure is not the opposite of success; it is part of success. — Arianna Huffington",
  "The only thing that overcomes hard luck is hard work. — Harry Golden",
  "Success is a journey, not a destination. — Arthur Ashe",
  "Keep your fears to yourself, but share your courage with others. — Robert Louis Stevenson",
  "Every accomplishment starts with the decision to try. — John F. Kennedy",
  "Be stronger than your strongest excuse. — Anonymous",
  "There is virtue in work and there is virtue in rest. Use both and overlook neither. — Alan Cohen",
  "It does not matter how slowly you go as long as you do not stop. — Confucius",
  "There is no failure except in no longer trying. — Elbert Hubbard",
  "Everything comes to him who hustles while he waits. — Thomas Edison",
  "If you get tired, learn to rest, not to quit. — Banksy",
  "What lies behind us and what lies before us are tiny matters compared to what lies within us. — Ralph Waldo Emerson",
  "Stay hungry, stay foolish. — Steve Jobs",
  "A champion is defined not by their wins but by how they can recover when they fall. — Serena Williams",
  "Do what is right, not what is easy. — Roy T. Bennett",
  "You are what you do, not what you say you’ll do. — Carl Jung",
  "Success is liking yourself, liking what you do, and liking how you do it. — Maya Angelou",
  "Greatness is earned, never bestowed. — Anonymous",
  "The climb might be tough, but the view is worth it. — Anonymous",
  "The habit of persistence is the habit of victory. — Herbert Kaufman",
  "A winner is a dreamer who never gives up. — Nelson Mandela",
  "Difficulties strengthen the mind, as labor does the body. — Seneca",
  "What we fear doing most is usually what we most need to do. — Tim Ferriss",
  "The pain you feel today will be the strength you feel tomorrow. — Anonymous",
  "Success is where preparation and opportunity meet. — Bobby Unser",
  "Keep your head up. God gives his hardest battles to his strongest soldiers. — Tupac Shakur",
  "Discipline is the bridge between goals and accomplishment. — Jim Rohn",
  "In a gentle way, you can shake the world. — Mahatma Gandhi",
  "Everything you can imagine is real. — Pablo Picasso",
  "Start by doing what is necessary; then do what is possible; and suddenly you are doing the impossible. — Francis of Assisi",
  "Work gives you meaning and purpose and life is empty without it. — Stephen Hawking",
  "Happiness depends upon ourselves. — Aristotle",
  "Do not be embarrassed by your failures, learn from them and start again. — Richard Branson",
  "The road to success and the road to failure are almost exactly the same. — Colin R. Davis",
  "Success is stumbling from failure to failure with no loss of enthusiasm. — Winston Churchill",
  "You cannot swim for new horizons until you have courage to lose sight of the shore. — William Faulkner",
  "The best dreams happen when you’re awake. — Cherie Gilderbloom",
  "Make your life a mission, not an intermission. — Arnold H. Glasgow",
  "Step by step and the thing is done. — Charles Atlas",
  "Big shots are only little shots who kept shooting. — Christopher Morley",
  "Try again. Fail again. Fail better. — Samuel Beckett",
  "A person who never made a mistake never tried anything new. — Albert Einstein",
  "We are what we repeatedly do. Excellence, then, is not an act, but a habit. — Will Durant",
  "Whether you think you can or think you can’t, you’re right. — Henry Ford",
  "If you want to conquer fear, do not sit home and think about it. Go out and get busy. — Dale Carnegie",
  "Perfection is not attainable, but if we chase perfection we can catch excellence. — Vince Lombardi",
  "Success is not in what you have, but who you are. — Bo Bennett",
  "Go confidently in the direction of your dreams. — Henry David Thoreau",
  "Our greatest weakness lies in giving up. The most certain way to succeed is always to try just one more time. — Thomas Edison",
  "A year from now you may wish you had started today. — Karen Lamb",
  "The grind never lies. — Ray Lewis",
  "Every strike brings me closer to the next home run. — Babe Ruth",
  "Focus on being productive instead of busy. — Tim Ferriss",
  "The cost of discipline is always less than the pain of regret. — Nido Qubein",
  "If you are persistent, you will get it. If you are consistent, you will keep it. — Harvey Mackay",
  "Your life does not get better by chance, it gets better by change. — Jim Rohn",
  "If you have no critics you’ll likely have no success. — Malcolm X",
  "To dare is to lose one’s footing momentarily. Not to dare is to lose oneself. — Soren Kierkegaard",
  "The reward for work well done is the opportunity to do more. — Jonas Salk",
  "Be willing to be a beginner every single morning. — Meister Eckhart",
  "You may have to fight a battle more than once to win it. — Margaret Thatcher",
  "The best view comes after the hardest climb. — Anonymous",
  "The struggle you’re in today is developing the strength you need for tomorrow. — Robert Tew",
  "Success is getting what you want. Happiness is wanting what you get. — Dale Carnegie",
  "Do what you feel in your heart to be right, for you’ll be criticized anyway. — Eleanor Roosevelt",
  "It is never too late to be what you might have been. — George Eliot",
  "To win without risk is to triumph without glory. — Pierre Corneille",
  "Great opportunities to help others seldom come, but small ones surround us every day. — Sally Koch",
  "If you want to achieve greatness stop asking for permission. — Anonymous",
  "The dreamers are the saviors of the world. — James Allen",
  "We can do anything we want to if we stick to it long enough. — Helen Keller",
  "Never let the fear of striking out keep you from playing the game. — Babe Ruth",
  "The biggest room in the world is the room for improvement. — Helmut Schmidt",
  "There is nothing impossible to they who will try. — Alexander the Great",
  "With the new day comes new strength and new thoughts. — Eleanor Roosevelt",
  "Success is not final, failure is not fatal: it is the courage to continue that counts. — Winston Churchill",
  "Keep your eyes on the goal, and just keep taking the next step towards completing it. — Anonymous",
  "Purpose is the reason you journey. Passion is the fire that lights your way. — Anonymous",
  "Effort only fully releases its reward after a person refuses to quit. — Napoleon Hill",
  "The more difficult the victory, the greater the happiness in winning. — Pele",
  "If it matters to you, you’ll find a way. — Charlie Gilkey",
  "You have power over your mind, not outside events. Realize this, and you will find strength. — Marcus Aurelius",
  "Every day is a chance to get better. — Anonymous",
  "The comeback is always stronger than the setback. — Anonymous",
  "Doubt kills more dreams than failure ever will. — Suzy Kassem",
  "If you want to fly, give up everything that weighs you down. — Buddha",
  "Keep going because you did not come this far just to come this far. — Anonymous",
  "Discipline is remembering what you want. — David Campbell",
  "You don’t find willpower, you create it. — Anonymous",
  "One important key to success is self-confidence. An important key to self-confidence is preparation. — Arthur Ashe",
  "There is no traffic jam on the extra mile. — Roger Staubach",
  "If you can’t outplay them, outwork them. — Ben Hogan",
  "Fear defeats more people than any other one thing in the world. — Ralph Waldo Emerson",
  "The successful man will profit from his mistakes and try again in a different way. — Dale Carnegie",
  "Stay patient and trust your journey. — Anonymous",
  "Genius is one percent inspiration and ninety-nine percent perspiration. — Thomas Edison",
  "The best investment is in the tools of one’s own trade. — Benjamin Franklin",
  "You don’t drown by falling in the water; you drown by staying there. — Edwin Louis Cole",
  "The difference between try and triumph is just a little umph. — Marvin Phillips",
  "Success is the child of audacity. — Benjamin Disraeli",
  "There is no royal road to anything. One thing at a time, all things in succession. — Josiah Gilbert Holland",
  "Do not let what you cannot do interfere with what you can do. — John Wooden",
  "Your present circumstances don’t determine where you can go; they merely determine where you start. — Nido Qubein",
  "You are capable of amazing things. — Anonymous",
  "Keep your dreams alive. Understand to achieve anything requires faith and belief in yourself. — Gail Devers",
  "Time is what we want most, but what we use worst. — William Penn",
  "You don’t have to see the whole staircase, just take the first step. — Martin Luther King Jr.",
  "Some people want it to happen, some wish it would happen, others make it happen. — Michael Jordan",
  "Make your work to be in keeping with your purpose. — Leonardo da Vinci",
  "One finds limits by pushing them. — Herbert Simon",
  "Courage starts with showing up and letting ourselves be seen. — Brene Brown",
  "Every moment is a fresh beginning. — T. S. Eliot",
  "Tough times never last, but tough people do. — Robert H. Schuller",
  "Success seems to be connected with action. Successful people keep moving. — Conrad Hilton",
  "Don’t be pushed around by the fears in your mind. Be led by the dreams in your heart. — Roy T. Bennett",
  "The surest way to make your dreams come true is to live them. — Roy T. Bennett",
  "Keep climbing. Your destination is worth the effort. — Anonymous",
  "Today is your opportunity to build the tomorrow you want. — Ken Poirot",
  "One task at a time is enough. One task at a time is best. — Anonymous",
  "Nothing worth having comes easy. — Theodore Roosevelt",
  "Hard work beats talent when talent doesn’t work hard. — Tim Notke",
  "A surplus of effort could overcome a deficit of confidence. — Sonia Sotomayor",
  "Character is power. — Booker T. Washington",
  "What we do in life echoes in eternity. — Marcus Aurelius",
  "The pain of discipline is far less than the pain of regret. — Sarah Bombell",
  "Push yourself, because no one else is going to do it for you. — Anonymous",
  "Little by little, a little becomes a lot. — Tanzanian Proverb",
  "Success is built on habits, not hopes. — Anonymous",
  "Be stubborn about your goals and flexible about your methods. — Anonymous",
  "Daily improvement is the key to staggering long-term results. — Robin Sharma",
  "You were given this life because you are strong enough to live it. — Anonymous",
  "Calm mind brings inner strength and self-confidence. — Dalai Lama",
  "One who gains strength by overcoming obstacles possesses the only strength which can overcome adversity. — Albert Schweitzer",
  "A diamond is a piece of coal that did well under pressure. — Henry Kissinger",
  "You can, you should, and if you’re brave enough to start, you will. — Stephen King",
  "No pressure, no diamonds. — Thomas Carlyle",
  "It is not the mountain we conquer but ourselves. — Edmund Hillary",
  "Persistence guarantees that results are inevitable. — Paramahansa Yogananda",
  "Success is a state of mind. If you want success, start thinking of yourself as a success. — Joyce Brothers",
  "Only those who dare to fail greatly can ever achieve greatly. — Robert F. Kennedy",
  "Victory belongs to the most persevering. — Napoleon Bonaparte",
  "The more you do, the more you can do. — Lucille Ball",
  "Your direction is more important than your speed. — Anonymous",
  "Keep it simple. Keep it steady. Keep it moving. — Anonymous",
  "What you stay focused on will grow. — Roy T. Bennett",
  "Every day brings new choices. — Martha Beck",
  "Consistency is the true foundation of trust. — Roy T. Bennett",
  "The strongest actions for a woman is to love herself and shine. — Anonymous",
  "Do not pray for an easy life; pray for the strength to endure a difficult one. — Bruce Lee",
  "A person with a new idea is a crank until the idea succeeds. — Mark Twain",
  "Life shrinks or expands in proportion to one’s courage. — Anais Nin",
  "Bravery is being the only one who knows you’re afraid. — Franklin P. Jones",
  "Courage doesn’t always roar. Sometimes courage is the quiet voice at the end of the day saying, I will try again tomorrow. — Mary Anne Radmacher",
  "The next best time is now. — Anonymous",
  "Work while they sleep. Learn while they party. Live like they dream. — Anonymous",
  "A disciplined mind leads to happiness. — Buddha",
  "Make it happen. Shock everyone. — Anonymous",
  "Every day is a new chance to do better. — Anonymous",
  "Your consistency is your signature. — Anonymous",
  "Quiet progress is still progress. — Anonymous",
  "You are built from the work you repeat. — Anonymous",
  "Lead with effort and let results follow. — Anonymous",
  "Steady hands build strong outcomes. — Anonymous",
  "The work you avoid today becomes the weight you carry tomorrow. — Anonymous",
  "Progress favors the patient. — Anonymous",
  "Even ordinary days can move you forward. — Anonymous",
  "Reliable effort makes rare results. — Anonymous",
  "Keep the promise you made to yourself. — Anonymous",
  "Your future is shaped by your routine. — Anonymous",
  "Stay humble and keep moving. — Anonymous",
  "Give your goals your best hour. — Anonymous",
  "Momentum begins with one honest step. — Anonymous",
  "Build the habit and the habit will build you. — Anonymous",
  "A calm start often wins the day. — Anonymous",
  "The next task is the path forward. — Anonymous",
  "Let discipline decide when motivation is absent. — Anonymous",
  "Strong days are built, not found. — Anonymous",
  "Consistency turns effort into identity. — Anonymous",
  "Today’s discipline is tomorrow’s ease. — Anonymous",
  "Keep going; clarity often comes after movement. — Anonymous",
  "A steady pace can carry great weight. — Anonymous",
  "Protect your focus like it is fuel. — Anonymous",
  "The simplest plan done well beats the perfect plan delayed. — Anonymous",
  "You do not need more time; you need more intention. — Anonymous",
  "Keep your standards high and your excuses low. — Anonymous",
  "Each good decision votes for the person you want to become. — Anonymous",
  "When in doubt, return to the next useful action. — Anonymous",
  "Quiet discipline has a loud future. — Anonymous"
];
const JOKES_OF_THE_DAY = [
  "Why did the scarecrow get promoted? Because he was outstanding in his field. — Anonymous",
  "I told my computer I needed a break, and it said no problem, it needed one too. — Anonymous",
  "Why don’t programmers like nature? Too many bugs. — Anonymous",
  "Why was the math book stressed? It had too many problems. — Anonymous",
  "I used to play piano by ear, but now I use my hands. — Anonymous",
  "Why did the coffee file a report? It got mugged. — Anonymous",
  "Why don’t skeletons fight each other? They don’t have the guts. — Anonymous",
  "Parallel lines have so much in common. It’s a shame they’ll never meet. — Anonymous",
  "Why did the stadium get hot after the game? All the fans left. — Anonymous",
  "I told my boss I needed a raise because three companies were after me. The gas, electric, and water companies. — Anonymous",
  "Why was the calendar nervous? Its days were numbered. — Anonymous",
  "I’m reading a book on anti-gravity. It’s impossible to put down. — Anonymous",
  "Why did the bicycle fall over? It was two-tired. — Anonymous",
  "Why don’t eggs tell jokes? They’d crack each other up. — Anonymous",
  "I asked the librarian if the library had books on paranoia. She whispered, they’re right behind you. — Anonymous",
  "Why did the golfer bring two pairs of pants? In case he got a hole in one. — Anonymous",
  "I only know 25 letters of the alphabet. I don’t know y. — Anonymous",
  "Why did the tomato blush? It saw the salad dressing. — Anonymous",
  "What do you call fake spaghetti? An impasta. — Anonymous",
  "Why did the cookie go to the doctor? It felt crummy. — Anonymous",
  "Why did the chicken join a band? Because it had the drumsticks. — Anonymous",
  "Why can’t your nose be 12 inches long? Because then it would be a foot. — Anonymous",
  "Why do bees have sticky hair? Because they use honeycombs. — Anonymous",
  "Why was the computer cold? It left its Windows open. — Anonymous",
  "What do you call cheese that isn’t yours? Nacho cheese. — Anonymous",
  "I would tell you a construction joke, but I’m still working on it. — Anonymous",
  "Why did the student eat his homework? The teacher said it was a piece of cake. — Anonymous",
  "Why don’t scientists trust atoms? Because they make up everything. — Anonymous",
  "How does a penguin build its house? Igloos it together. — Anonymous",
  "Why did the orange stop halfway up the hill? It ran out of juice. — Anonymous"
];
const USER_MANUAL_SECTIONS = {
  overview: {
    title: "📘 Overview",
    lines: [
      "This bot records attendance into the shared monthly Google Sheet.",
      "If you are new, send /start and enter the secret code assigned to your appointment.",
      "Once onboarding is complete, /start opens the main menu any time."
    ]
  },
  attendance: {
    title: "📝 Today's Attendance",
    lines: [
      "Use Today's Attendance to submit or update your status for today.",
      "The bot writes your selection into your appointment row and today's date column in the current month sheet.",
      "After you submit, the bot confirms the recorded status and shows a quote or joke."
    ]
  },
  weekly: {
    title: "📅 Weekly Attendance",
    lines: [
      "Use This Week or Next Week to submit Monday-to-Friday attendance in one guided flow.",
      "Public holidays are prefilled as PH.",
      "Use Skip Day to keep the current value for that date unchanged."
    ]
  },
  summary: {
    title: "📊 Summary",
    lines: [
      "Use Summary to view attendance counts and status breakdowns for a selected day.",
      "Use Previous Day and Next Day to move across dates.",
      "Use Unaccounted to view personnel who still have no attendance recorded for that day."
    ]
  },
  admin: {
    title: "🛠️ Admin Features",
    lines: [
      "Admins can manage the roster, send invitations, manage admin access, send prompts, and deregister users.",
      "Admins can also edit the allowed attendance codes and sort them by usage directly from the Admin Menu.",
      "The ONBOARDING sheet is the source of truth for appointment names and ordering.",
      "Default admin appointments only take effect when they are currently onboarded."
    ]
  },
  reminders: {
    title: "⏰ Reminders",
    lines: [
      "Automatic reminders run at 0700 hrs and 0800 hrs by default.",
      "Reminders are only sent on weekdays and non-public holidays.",
      "The second reminder only goes to users whose attendance is still blank."
    ]
  },
  troubleshooting: {
    title: "🧰 Troubleshooting",
    lines: [
      "If /start asks for a secret code, this Telegram account is not currently bound.",
      "If buttons appear stale, send /start again to reopen the latest menu.",
      "Use /lastupdate if you want to check when the last full Google Sheets sync completed."
    ]
  }
};

function buildAdminMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📋 Roster", "admin:menu:roster"),
      Markup.button.callback("✉️ Send Invitation", "admin:menu:codes:0")
    ],
    [
      Markup.button.callback("👮 Manage Admins", "admin:menu:admins"),
      Markup.button.callback("📣 Prompt All", "admin:promptall")
    ],
    [
      Markup.button.callback("🧩 Attendance Options", "admin:menu:options"),
      Markup.button.callback("🧾 Deregister Person", "admin:menu:deregister:0")
    ],
    [
      Markup.button.callback("📤 Push Attendance", "admin:flushqueue"),
      Markup.button.callback("📬 Outstanding", "admin:queue")
    ],
    [
      Markup.button.callback("🔙 Back", "home:main"),
      Markup.button.callback("❌ Close", "admin:close")
    ],
  ]);
}

function buildAdminRosterMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🕓 Pending", "admin:pending"),
      Markup.button.callback("🔄 Sync Roster", "admin:syncroster")
    ],
    [
      Markup.button.callback("➕ Add Appointment", "admin:appointments:add"),
      Markup.button.callback("➖ Remove Appointment", "admin:menu:appointments:remove:0")
    ],
    [
      Markup.button.callback("🔀 Transfer User", "admin:menu:transfer:0")
    ],
    [
      Markup.button.callback("🔓 Clear All Protections", "admin:clearprotections"),
      Markup.button.callback("📄 Change Spreadsheet", "admin:changespreadsheet")
    ],
    [
      Markup.button.callback("🔧 Self-Heal Logs", "admin:selfheallogs:0")
    ],
    [
      Markup.button.callback("🔙 Back", "admin:main"),
      Markup.button.callback("❌ Close", "admin:close")
    ]
  ]);
}

function buildHomeMenu(isAdminUser, timezone) {
  const buttons = [
    Markup.button.callback("📝 Today's Attendance", "home:attendance"),
    ...getHomeWeekButtons(timezone),
    Markup.button.callback("🏢 My Department", "home:department")
  ];

  if (isAdminUser) {
    buttons.push(Markup.button.callback("🛠️ Admin Menu", "home:admin"));
  }

  buttons.push(
    Markup.button.callback("⚠️ Deregister", "home:deregister"),
    Markup.button.callback("📊 Summary", "home:summary"),
    Markup.button.callback("❓ Help", "home:help")
  );

  if (process.env.GITHUB_TOKEN) {
    buttons.push(Markup.button.callback("🐛 Report Issue", "home:reportissue"));
  }

  buttons.push(Markup.button.callback("❌ Close", "home:close"));

  const rows = [];

  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }

  return Markup.inlineKeyboard(rows);
}

function buildSelfDeregisterMenu(interactionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, Deregister Me", `home:deregister:confirm:${interactionId}`)],
    [
      Markup.button.callback("🔙 Back", "home:main"),
      Markup.button.callback("❌ Close", "home:close")
    ]
  ]);
}

function buildManualMenu(includeAdminSection = false) {
  const rows = [
    [
      Markup.button.callback("📘 Overview", "manual:overview"),
      Markup.button.callback("📝 Today", "manual:attendance")
    ],
    [
      Markup.button.callback("📅 Week", "manual:weekly"),
      Markup.button.callback("📊 Summary", "manual:summary")
    ],
    [
      Markup.button.callback("⏰ Reminders", "manual:reminders"),
      Markup.button.callback("🧰 Help", "manual:troubleshooting")
    ]
  ];

  if (includeAdminSection) {
    rows.splice(2, 0, [Markup.button.callback("🛠️ Admin", "manual:admin")]);
  }

  rows.push([
    Markup.button.callback("🔙 Back", "home:main"),
    Markup.button.callback("❌ Close", "home:close")
  ]);

  return Markup.inlineKeyboard([
    ...rows
  ]);
}

function buildSummaryMenu(date, timezone, backTarget = "admin:menu:roster", options = {}) {
  const previousDate = toIsoDateString(shiftDate(date, -1), timezone);
  const nextDate = toIsoDateString(shiftDate(date, 1), timezone);
  const namespace = backTarget.startsWith("home:") ? "home" : "admin";
  const rows = [[
    Markup.button.callback("⬅️ Previous Day", `${namespace}:summary:${previousDate}`),
    Markup.button.callback("➡️ Next Day", `${namespace}:summary:${nextDate}`)
  ]];

  if (options.includeUnaccounted !== false) {
    rows.push([
      Markup.button.callback("🕳️ Unaccounted", `${namespace}:summary:unaccounted:${toIsoDateString(date, timezone)}`)
    ]);
  }

  rows.push(
    [
      Markup.button.callback("🔙 Back", backTarget),
      Markup.button.callback("❌ Close", `${namespace}:close`)
    ]
  );

  return Markup.inlineKeyboard(rows);
}

function buildAdminManageMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Add Admin", "admin:menu:addadmin:0"),
      Markup.button.callback("➖ Remove Admin", "admin:menu:removeadmin:0")
    ],
    [
      Markup.button.callback("🔙 Back", "admin:main"),
      Markup.button.callback("❌ Close", "admin:close")
    ]
  ]);
}

function buildAttendanceOptionsMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Add Option", "admin:options:add"),
      Markup.button.callback("➖ Remove Option", "admin:options:remove:0")
    ],
    [
      Markup.button.callback("🔄 Reset Defaults", "admin:options:reset")
    ],
    [
      Markup.button.callback("🔙 Back", "admin:main"),
      Markup.button.callback("❌ Close", "admin:close")
    ]
  ]);
}

function buildAppointmentManagementBackMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔙 Back", "admin:menu:roster"),
      Markup.button.callback("❌ Close", "admin:close")
    ]
  ]);
}

function buildSyncPendingMenu(backTarget) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Sync Roster", "admin:syncroster")],
    [
      Markup.button.callback("🔙 Back", backTarget),
      Markup.button.callback("❌ Close", "admin:close")
    ]
  ]);
}

function buildUnaccountedMenu(date, timezone, rows, backTarget, namespace) {
  return Markup.inlineKeyboard([
    ...rows,
    [
      Markup.button.callback("🔙 Back", `${namespace}:summary:${toIsoDateString(date, timezone)}`),
      Markup.button.callback("❌ Close", `${namespace}:close`)
    ]
  ]);
}

function buildPagedSelectionMenu(
  items,
  page,
  itemPrefix,
  pageCallbackPrefix,
  backTarget,
  menuOptions = {}
) {
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const startIndex = safePage * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);
  const rows = [];

  for (let index = 0; index < pageItems.length; index += 4) {
    rows.push(
      pageItems.slice(index, index + 4).map((item, offset) => {
        const absoluteIndex = startIndex + index + offset;
        const token = menuOptions.itemTokenBuilder
          ? menuOptions.itemTokenBuilder(item, absoluteIndex)
          : absoluteIndex;
        return Markup.button.callback(item.label, `${itemPrefix}:${token}`);
      })
    );
  }

  const navRow = [];

  if (safePage > 0) {
    navRow.push(Markup.button.callback("⬅️ Prev", `${pageCallbackPrefix}:${safePage - 1}`));
  }

  if (safePage < totalPages - 1) {
    navRow.push(Markup.button.callback("➡️ Next", `${pageCallbackPrefix}:${safePage + 1}`));
  }

  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([
    Markup.button.callback("🔙 Back", backTarget),
    Markup.button.callback("❌ Close", "admin:close")
  ]);

  return Markup.inlineKeyboard(rows);
}

function stableSelectionFingerprint(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("base64url")
    .slice(0, 8);
}

function fingerprintedSelectionToken(item, index, identityField = "appointment") {
  return `${index}:${stableSelectionFingerprint(item?.[identityField])}`;
}

function resolveFingerprintedSelection(items, indexRaw, fingerprint, identityField = "appointment") {
  const item = items[Number(indexRaw)];

  if (
    !item ||
    stableSelectionFingerprint(item?.[identityField]) !== fingerprint
  ) {
    return null;
  }

  return item;
}

function beginSelectionInteraction(ctx, kind, items, options = {}) {
  const choices = Object.fromEntries(
    items.map((item, index) => [String(index), item])
  );
  return beginInteraction(ctx, kind, choices, options);
}

async function rejectExpiredInteraction(ctx, message = "This menu is no longer current. Nothing was changed.") {
  await ctx.answerCbQuery(message, { show_alert: true }).catch(() => {});
  try {
    await ctx.editMessageText(message, Markup.inlineKeyboard([]));
  } catch {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(message).catch(() => {});
  }
}

function buildInlineAttendanceMenu(
  options,
  page,
  itemPrefix,
  pagePrefix,
  backTarget,
  extraRows = [],
  menuOptions = {}
) {
  const pageSize = menuOptions.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(options.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const startIndex = safePage * pageSize;
  const pageItems = options.slice(startIndex, startIndex + pageSize);
  const rows = [...extraRows];

  for (let index = 0; index < pageItems.length; index += 3) {
    rows.push(
      pageItems.slice(index, index + 3).map((option, offset) => {
        const absoluteIndex = startIndex + index + offset;
        const token = menuOptions.itemTokenBuilder
          ? menuOptions.itemTokenBuilder(option, absoluteIndex)
          : absoluteIndex;
        return Markup.button.callback(option, `${itemPrefix}:${token}`);
      })
    );
  }

  const navRow = [];

  if (safePage > 0) {
    navRow.push(Markup.button.callback("⬅️ Prev", `${pagePrefix}:${safePage - 1}`));
  }

  if (safePage < totalPages - 1) {
    navRow.push(Markup.button.callback("➡️ Next", `${pagePrefix}:${safePage + 1}`));
  }

  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([
    Markup.button.callback("🔙 Back", backTarget),
    Markup.button.callback("❌ Close", "home:close")
  ]);

  return Markup.inlineKeyboard(rows);
}

function getAttendanceOptionGroups(config) {
  const activeOptions = new Set(config.attendanceOptions ?? []);
  const groups = [];
  const assigned = new Set();

  for (const group of config.attendanceGroups ?? []) {
    const options = (group.options ?? []).filter((option) => activeOptions.has(option));
    if (options.length === 0) continue;
    groups.push({ ...group, options });
    options.forEach((option) => assigned.add(option));
  }

  const uncategorized = [...activeOptions].filter((option) => !assigned.has(option));
  if (uncategorized.length > 0) {
    groups.push({
      id: "other",
      key: "other",
      label: "Other",
      options: uncategorized.sort((left, right) => left.localeCompare(right))
    });
  }

  return groups;
}

function buildAttendanceGroupMenu(config, groupCallbackBuilder, backTarget, extraRows = []) {
  const groups = getAttendanceOptionGroups(config);
  const rows = [...extraRows];

  for (let index = 0; index < groups.length; index += 3) {
    rows.push(
      groups.slice(index, index + 3).map((group) =>
        Markup.button.callback(
          group.label,
          groupCallbackBuilder(group.key)
        )
      )
    );
  }

  rows.push([
    Markup.button.callback("🔙 Back", backTarget),
    Markup.button.callback("❌ Close", "home:close")
  ]);

  return Markup.inlineKeyboard(rows);
}

function attendanceStatusFingerprint(status) {
  return createHash("sha256")
    .update(String(status ?? ""), "utf8")
    .digest("base64url")
    .slice(0, 8);
}

function newAttendancePromptId() {
  return randomBytes(6).toString("base64url");
}

function buildDailyAttendanceIdempotencyKey(chatId, promptId, isoDate, status) {
  return `daily:${chatId}:${promptId}:${isoDate}:${attendanceStatusFingerprint(status)}`;
}

function buildWeeklyAttendanceIdempotencyKey(flowId, appointment, isoDate, status) {
  return `weekly:${flowId}:${appointment}:${isoDate}:${attendanceStatusFingerprint(status)}`;
}

function buildDatedAttendanceMenu(
  config,
  date,
  page,
  itemPrefix,
  pagePrefix,
  backTarget,
  extraRows = [],
  menuOptions = {}
) {
  const isoDate = toIsoDateString(date, config.timezone);
  const promptSuffix = menuOptions.promptId ? `:${menuOptions.promptId}` : "";

  if (typeof menuOptions.groupCallbackBuilder === "function") {
    return buildAttendanceGroupMenu(
      config,
      (groupKey) => menuOptions.groupCallbackBuilder(groupKey, isoDate, menuOptions.promptId ?? "legacy"),
      backTarget,
      extraRows
    );
  }

  return buildInlineAttendanceMenu(
    config.attendanceOptions,
    page,
    `${itemPrefix}${promptSuffix}:${isoDate}`,
    `${pagePrefix}${promptSuffix}:${isoDate}`,
    backTarget,
    extraRows,
    {
      itemTokenBuilder: (option, index) =>
        `${index}:${attendanceStatusFingerprint(option)}`
    }
  );
}

function buildDatedAttendanceGroupMenu(
  config,
  date,
  groupKey,
  itemPrefix,
  backTarget,
  extraRows = [],
  menuOptions = {}
) {
  const group = getAttendanceOptionGroups(config).find((entry) => entry.key === groupKey);
  if (!group) {
    return buildDatedAttendanceMenu(config, date, 0, itemPrefix, "", backTarget, extraRows, menuOptions);
  }

  const isoDate = toIsoDateString(date, config.timezone);
  const promptSuffix = menuOptions.promptId ? `:${menuOptions.promptId}` : "";
  const optionIndexByValue = new Map(config.attendanceOptions.map((option, index) => [option, index]));

  return buildInlineAttendanceMenu(
    group.options,
    0,
    `${itemPrefix}${promptSuffix}:${isoDate}`,
    "",
    backTarget,
    extraRows,
    {
      pageSize: 100,
      itemTokenBuilder: (option) => {
        const absoluteIndex = optionIndexByValue.get(option);
        return `${absoluteIndex}:${attendanceStatusFingerprint(option)}`;
      }
    }
  );
}

function buildAttendanceGroupOptionMenu(config, groupKey, itemPrefix, backTarget, extraRows = []) {
  const group = getAttendanceOptionGroups(config).find((entry) => entry.key === groupKey);
  if (!group) {
    return buildAttendanceGroupMenu(config, () => backTarget, backTarget);
  }

  const optionIndexByValue = new Map(config.attendanceOptions.map((option, index) => [option, index]));
  return buildInlineAttendanceMenu(
    group.options,
    0,
    itemPrefix,
    "",
    backTarget,
    extraRows,
    {
      pageSize: 100,
      itemTokenBuilder: (option) =>
        `${optionIndexByValue.get(option)}:${attendanceStatusFingerprint(option)}`
    }
  );
}

function formatUserName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
}

function isPrivateTelegramIdentity(ctx) {
  return Boolean(
    ctx.chat?.type === "private" &&
    ctx.from?.id &&
    String(ctx.chat.id) === String(ctx.from.id)
  );
}

function normalizeSecretCode(code) {
  return String(code ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function pickQuoteOrJoke() {
  const messages = [...INSPIRATIONAL_QUOTES, ...JOKES_OF_THE_DAY];
  const index = Math.floor(Math.random() * messages.length);
  return messages[index];
}

function buildManualText(sectionKey, isAdminUser = false) {
  const section = USER_MANUAL_SECTIONS[sectionKey] ?? USER_MANUAL_SECTIONS.overview;
  const lines = [
    section.title,
    "",
    ...section.lines
  ];

  if (sectionKey === "overview") {
    lines.push("");
    lines.push("Use the buttons below to open the section you need.");

    if (isAdminUser) {
      lines.push("The Admin section is included because this account currently has admin access.");
    }
  }

  return lines.join("\n");
}

async function sendHelp(ctx, config) {
  const isAdminUser = await isAdmin(ctx, config);
  await sendOrUpdateAdminMessage(
    ctx,
    buildManualText("overview", isAdminUser),
    buildManualMenu(isAdminUser)
  );
}

async function sendOrUpdateAdminMessage(ctx, text, replyMarkup, extraOptions = {}) {
  const messageOptions = {
    ...(replyMarkup ?? {}),
    ...extraOptions
  };

  if (ctx.callbackQuery?.message) {
    let editedMessage = null;

    try {
      editedMessage = await ctx.editMessageText(text, messageOptions);
    } catch (error) {
      const description = error?.response?.description ?? error?.message ?? "";

      if (!description.includes("message is not modified")) {
        throw error;
      }
    }

    if (ctx.callbackQuery?.id) {
      try {
        await ctx.answerCbQuery();
      } catch (error) {
        const description = error?.response?.description ?? error?.message ?? "";

        if (!description.includes("query is too old")) {
          throw error;
        }
      }
    }

    return editedMessage || ctx.callbackQuery.message;
  }

  return ctx.reply(text, messageOptions);
}

async function sendBackgroundBotMessage(
  bot,
  chatId,
  text,
  replyMarkup,
  extraOptions = {}
) {
  const [outcome] = await allSettledConcurrent([
    (signal) => bot.telegram.callApi(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        ...(replyMarkup ?? {}),
        ...extraOptions
      },
      { signal }
    )
  ], 1);

  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}

function getMessageId(message) {
  const messageId = Number(message?.message_id);
  return Number.isInteger(messageId) && messageId > 0 ? messageId : null;
}

function appendAttendancePromptMessageId(user, messageId) {
  const existingIds = Array.isArray(user?.attendancePromptMessageIds)
    ? user.attendancePromptMessageIds
    : [];
  const normalizedIds = existingIds
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);

  if (Number.isInteger(messageId) && messageId > 0) {
    normalizedIds.push(messageId);
  }

  return [...new Set(normalizedIds)].slice(-MAX_TRACKED_ATTENDANCE_PROMPTS);
}

async function removeObsoleteAttendancePromptMessages(
  telegram,
  chatId,
  messageIds,
  keepMessageId = null
) {
  const obsoleteIds = [...new Set(
    (Array.isArray(messageIds) ? messageIds : [])
      .map(Number)
      .filter((messageId) =>
        Number.isInteger(messageId) &&
        messageId > 0 &&
        messageId !== keepMessageId
      )
  )];

  await Promise.allSettled(obsoleteIds.map(async (messageId) => {
    try {
      await telegram.deleteMessage(chatId, messageId);
    } catch {
      // Telegram only allows message deletion for a limited time. If an old
      // reminder can no longer be deleted, at least retire its active buttons.
      try {
        await telegram.editMessageReplyMarkup(
          chatId,
          messageId,
          undefined,
          { inline_keyboard: [] }
        );
      } catch {
        // Missing/already-deleted messages need no further cleanup.
      }
    }
  }));
}

function buildInviteMessage(invite, bot, options = {}) {
  const useHtml = options.html === true;
  const botLink = bot.botInfo?.username
    ? `https://t.me/${bot.botInfo.username}`
    : "Open the attendance bot in Telegram";
  const codeValue = useHtml
    ? `<code>${escapeHtml(invite.secretCode)}</code>`
    : invite.secretCode;

  return [
    `Hello ${useHtml ? escapeHtml(invite.appointment) : invite.appointment},`,
    "",
    "Please register for the attendance bot.",
    `1. Open the bot: ${botLink}`,
    "2. Send /start",
    `3. Enter your registration code: ${codeValue}`,
    "",
    useHtml
      ? "Tap and hold the code block to copy it, then paste it when the bot asks for it."
      : "Copy and paste the code exactly when the bot asks for it."
  ].join("\n");
}

function buildInviteShareUrl(invite, bot) {
  const botLink = bot.botInfo?.username
    ? `https://t.me/${bot.botInfo.username}`
    : "";
  const text = buildInviteMessage(invite, bot);
  const query = new URLSearchParams({
    text
  });

  if (botLink) {
    query.set("url", botLink);
  }

  return `https://t.me/share/url?${query.toString()}`;
}

function buildInviteReplyMarkup(invite, bot, backCallback = null) {
  const inlineKeyboard = [[
    {
      text: "📨 Send Invitation",
      url: buildInviteShareUrl(invite, bot)
    }
  ]];

  if (backCallback) {
    inlineKeyboard.push([
      { text: "🔙 Back", callback_data: backCallback },
      { text: "❌ Close", callback_data: "admin:close" }
    ]);
  }

  return { reply_markup: { inline_keyboard: inlineKeyboard } };
}

function shiftDate(date, dayOffset) {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + dayOffset);
  return nextDate;
}

function parseIsoDate(dateValue) {
  const match = String(dateValue ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
}

function formatFullDateLabel(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(date);
}

function formatCorrectAsAt(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(date);
}

function getGreetingForTime(timezone, date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false
    }).format(date)
  );

  if (hour < 12) {
    return "Good Morning";
  }

  if (hour < 18) {
    return "Good Afternoon";
  }

  return "Good Evening";
}

function getWeekdayIndex(timezone, date = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short"
  }).format(date);
  const weekdayOrder = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6
  };

  return weekdayOrder[weekday] ?? 0;
}

function getHomeWeekButtons(timezone = "Asia/Singapore", date = new Date()) {
  const weekdayIndex = getWeekdayIndex(timezone, date);

  if (weekdayIndex === 0) {
    return [
      Markup.button.callback("📅 This Week", "home:week:this"),
      Markup.button.callback("🗓️ Next Week", "home:week:next")
    ];
  }

  if (weekdayIndex >= 5) {
    return [Markup.button.callback("🗓️ Next Week", "home:week:next")];
  }

  return [Markup.button.callback("📅 This Week", "home:week:this")];
}

function getHomeWeekDescriptions(timezone = "Asia/Singapore", date = new Date()) {
  const weekdayIndex = getWeekdayIndex(timezone, date);

  if (weekdayIndex === 0) {
    return [
      "📅 This Week: Review and submit attendance for this workweek.",
      "🗓️ Next Week: Prepare your attendance for the coming workweek."
    ];
  }

  if (weekdayIndex >= 5) {
    return [
      "🗓️ Next Week: Prepare your attendance for the coming workweek."
    ];
  }

  return [
    "📅 This Week: Review and submit attendance for this workweek."
  ];
}

function formatAttendanceDateLabel(date, timezone) {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    weekday: "long"
  }).formatToParts(date);
  const parts = Object.fromEntries(formatted.map((part) => [part.type, part.value]));
  return `${parts.day} ${parts.month} ${parts.year} (${parts.weekday})`;
}

function formatMilitaryTime(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const mapped = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${mapped.hour}${mapped.minute}`;
}

function isAfterAttendanceReminderCutoff(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const mapped = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const numericTime = Number(`${mapped.hour}${mapped.minute}`);
  return numericTime > 845;
}

function sortAppointmentsForAdmin(items, config = null) {
  const fallbackPriority = new Map([
    ["CO", 0],
    ["XO", 1],
    ["COXN", 2],
    ["SCSE", 3],
    ["OPS 1", 4]
  ]);

  return [...items].sort((left, right) => {
    const leftKey = left.appointment.toUpperCase();
    const rightKey = right.appointment.toUpperCase();
    const leftPriority = config?.appointmentOrderIndex?.has(leftKey)
      ? config.appointmentOrderIndex.get(leftKey)
      : fallbackPriority.has(leftKey)
        ? fallbackPriority.get(leftKey)
      : Number.MAX_SAFE_INTEGER;
    const rightPriority = config?.appointmentOrderIndex?.has(rightKey)
      ? config.appointmentOrderIndex.get(rightKey)
      : fallbackPriority.has(rightKey)
        ? fallbackPriority.get(rightKey)
      : Number.MAX_SAFE_INTEGER;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return left.appointment.localeCompare(right.appointment);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Returns a Map<UPPER_NAME, arrayIndex> for the snapshot's appointments array.
// Built lazily on first call and stored as a non-enumerable property so it is
// invisible to JSON serialization and object spread. Rebuilt automatically
// whenever adminCache replaces the snapshot object with a fresh one.
function getSnapshotAppointmentIndex(snapshot) {
  if (!snapshot._appointmentIndex) {
    Object.defineProperty(snapshot, "_appointmentIndex", {
      value: new Map(snapshot.appointments.map((apt, i) => [apt.toUpperCase(), i])),
      enumerable: false,
      configurable: true,
      writable: true
    });
  }
  return snapshot._appointmentIndex;
}

function getCachedAttendanceStatus(cache, config, appointment, date) {
  const month = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    month: "short"
  }).format(date);
  const year = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    year: "2-digit"
  }).format(date);
  const title = `${month} ${year}`;
  const snapshot = cache.sheetSnapshots?.snapshots?.get(title);

  if (!snapshot) {
    return "";
  }

  const appointmentIndex = getSnapshotAppointmentIndex(snapshot).get(appointment.toUpperCase());

  if (appointmentIndex === undefined) {
    return "";
  }

  const day = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      day: "numeric"
    }).format(date)
  );

  return String(snapshot.statusesByDay.get(day)?.[appointmentIndex] ?? "").trim();
}

function normalizeDepartmentKey(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function getDepartmentOptions(config = {}) {
  if (Array.isArray(config.hierarchy) && config.hierarchy.length > 0) {
    return config.hierarchy.map((entry) => ({
      key: entry.key,
      label: entry.label,
      type: entry.type,
      parentId: entry.parentId ?? null
    }));
  }

  return DEPARTMENT_BUCKETS.map((entry) => ({
    key: entry.key,
    label: entry.label
  }));
}

function getDepartmentLabelByKey(config, departmentKey) {
  return getDepartmentOptions(config).find((entry) => entry.key === departmentKey)?.label ?? null;
}

function getDepartmentKeyForAppointment(config, appointment) {
  const normalizedAppointment = String(appointment ?? "").trim().toUpperCase();
  const configuredMeta = config?.appointmentMetadataByName?.get?.(normalizedAppointment);

  if (configuredMeta?.hierarchyNodeKey) {
    return configuredMeta.hierarchyNodeKey;
  }

  const label = classifyAppointmentDepartment(appointment);

  if (!label) {
    return null;
  }

  return normalizeDepartmentKey(label);
}

function formatDepartmentStatus(status) {
  return String(status ?? "").trim() || "-";
}

function formatDepartmentWeekLabel(dates, timezone) {
  if (!Array.isArray(dates) || dates.length === 0) {
    return "No dates available";
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  const firstLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short"
  }).format(first);
  const lastLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    year: "2-digit"
  }).format(last);

  return `${firstLabel} to ${lastLabel}`;
}

function buildDepartmentWorkweekViewModel(cache, config, viewer, options = {}) {
  if (!viewer?.appointment) {
    return { ok: false, reason: "not_bound" };
  }

  const viewerDepartmentKey = getDepartmentKeyForAppointment(config, viewer.appointment);

  if (!viewerDepartmentKey) {
    return { ok: false, reason: "unclassified" };
  }

  const canSwitchDepartments = options.isAdminUser === true;
  const requestedKey = normalizeDepartmentKey(options.departmentKey || viewerDepartmentKey);
  const departmentKey = canSwitchDepartments ? requestedKey : viewerDepartmentKey;
  const departmentLabel = getDepartmentLabelByKey(config, departmentKey);

  if (!departmentLabel) {
    return { ok: false, reason: "unknown_department" };
  }

  const weekOffset = Number(options.weekOffset ?? 0);
  const weekDates = getWorkweekDates(config.timezone, weekOffset).map(
    (value) => new Date(value)
  );
  const activeAppointments = (cache.activeCodes ?? [])
    .map((entry) => entry.appointment)
    .filter(Boolean);
  const appointments = activeAppointments.filter(
    (appointment) => getDepartmentKeyForAppointment(config, appointment) === departmentKey
  );
  const page = Math.max(0, Number(options.page ?? 0));
  const totalPages = Math.max(1, Math.ceil(appointments.length / DEPARTMENT_MEMBER_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const startIndex = safePage * DEPARTMENT_MEMBER_PAGE_SIZE;
  const pageAppointments = appointments.slice(startIndex, startIndex + DEPARTMENT_MEMBER_PAGE_SIZE);
  const members = pageAppointments.map((appointment, index) => ({
    appointment,
    absoluteIndex: startIndex + index,
    rowNumber: startIndex + index + 1,
    statuses: weekDates.map((date) => getCachedAttendanceStatus(cache, config, appointment, date))
  }));

  return {
    ok: true,
    departmentKey,
    departmentLabel,
    viewerDepartmentKey,
    canSwitchDepartments,
    weekOffset,
    weekDates,
    weekLabel: formatDepartmentWeekLabel(weekDates, config.timezone),
    page: safePage,
    totalPages,
    members,
    totalMembers: appointments.length,
    allDepartmentOptions: getDepartmentOptions(config)
  };
}

function buildDepartmentMenu(viewModel) {
  const rows = [];

  for (const member of viewModel.members) {
    rows.push(
      DEPARTMENT_WEEKDAY_LABELS.map((weekday, dayIndex) =>
        Markup.button.callback(
          `${member.rowNumber} ${weekday}`,
          `home:department:edit:${viewModel.departmentKey}:${viewModel.weekOffset}:${viewModel.page}:${member.absoluteIndex}:${dayIndex}:${stableSelectionFingerprint(member.appointment)}`
        )
      )
    );
  }

  const pageNavRow = [];

  if (viewModel.page > 0) {
    pageNavRow.push(
      Markup.button.callback(
        "⬆️ Prev Members",
        `home:department:view:${viewModel.departmentKey}:${viewModel.weekOffset}:${viewModel.page - 1}`
      )
    );
  }

  if (viewModel.page < viewModel.totalPages - 1) {
    pageNavRow.push(
      Markup.button.callback(
        "⬇️ Next Members",
        `home:department:view:${viewModel.departmentKey}:${viewModel.weekOffset}:${viewModel.page + 1}`
      )
    );
  }

  if (pageNavRow.length > 0) {
    rows.push(pageNavRow);
  }

  rows.push([
    Markup.button.callback(
      "⬅️ Previous Week",
      `home:department:view:${viewModel.departmentKey}:${viewModel.weekOffset - 1}:0`
    ),
    Markup.button.callback(
      "Next Week ➡️",
      `home:department:view:${viewModel.departmentKey}:${viewModel.weekOffset + 1}:0`
    )
  ]);

  if (viewModel.canSwitchDepartments) {
    rows.push([
      Markup.button.callback(
        "🔄 Switch Department",
        `home:department:switch:${viewModel.departmentKey}:${viewModel.weekOffset}:${viewModel.page}`
      )
    ]);
  }

  rows.push([
    Markup.button.callback("🔙 Back", "home:main"),
    Markup.button.callback("❌ Close", "home:close")
  ]);

  return Markup.inlineKeyboard(rows);
}

function formatDepartmentViewMessage(viewModel, timezone) {
  const lines = [
    `<b><u>My Department</u></b>`,
    `<b>${escapeHtml(viewModel.departmentLabel)}</b>`,
    `Workweek: ${escapeHtml(viewModel.weekLabel)}`,
    ""
  ];

  if (viewModel.totalMembers === 0) {
    lines.push("No appointments are currently assigned to this department.");
  } else {
    lines.push("Tap the matching weekday button for the numbered row below.");
    lines.push("");

    for (const member of viewModel.members) {
      lines.push(`<b>${member.rowNumber}. ${escapeHtml(member.appointment)}</b>`);
      lines.push(
        member.statuses
          .map((status, index) => `${DEPARTMENT_WEEKDAY_LABELS[index]}: ${escapeHtml(formatDepartmentStatus(status))}`)
          .join(" | ")
      );
      lines.push("");
    }

    lines.push(
      `Showing ${viewModel.members.length === 0 ? 0 : viewModel.members[0].rowNumber}-${viewModel.members.at(-1)?.rowNumber ?? 0} of ${viewModel.totalMembers}`
    );
  }

  return lines.join("\n").trim();
}

function buildDepartmentPickerMenu(departmentOptions, weekOffset, backDepartmentKey, backPage) {
  const rows = departmentOptions.map((option) => [
    Markup.button.callback(
      option.label,
      `home:department:select:${option.key}:${weekOffset}`
    )
  ]);

  rows.push([
    Markup.button.callback(
      "🔙 Back",
      `home:department:view:${backDepartmentKey}:${weekOffset}:${backPage}`
    ),
    Markup.button.callback("❌ Close", "home:close")
  ]);

  return Markup.inlineKeyboard(rows);
}


function formatSyncStatusTimestamp(timestamp, timezone) {
  if (!timestamp) {
    return "Not completed yet";
  }

  return formatCorrectAsAt(new Date(timestamp), timezone);
}

function getLatestHomeSynchronizationTimestamp(syncStatus) {
  if (!syncStatus) {
    return 0;
  }

  return Number(syncStatus.lastFiveMinuteReconcileAt || 0);
}

function formatHomeSynchronizationTimestamp(timestamp, timezone) {
  if (!timestamp) {
    return "Not completed yet";
  }

  const date = new Date(timestamp);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replaceAll(":", "");
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit"
  }).format(date);
  const month = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    month: "short"
  }).format(date);
  const year = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "2-digit"
  }).format(date);
  return `${time} ${day} ${month} ${year}`;
}

function buildHomeMenuText({ greeting, name, isAdminUser, timezone, syncStatus }) {
  const todayLabel = formatAttendanceDateLabel(new Date(), timezone);
  const lines = [
    `${greeting}, ${name}. Today is ${todayLabel}.`,
    "",
    "Choose an action:",
    "",
    "📝 Today's Attendance: Submit or update today's attendance.",
    ...getHomeWeekDescriptions(timezone),
    "🏢 My Department: View and edit your department's workweek.",
    "📊 Summary: View attendance counts for a selected day.",
    "❓ Help: Open the short user guide."
  ];

  if (isAdminUser) {
    lines.push(
      "",
      "🛠️ Admin Menu: Roster, invitations, prompts, queue, and settings."
    );
  }

  lines.push(
    "",
    "⚠️ Deregister: Remove this Telegram binding.",
    "❌ Close: Close this menu."
  );

  if (isAdminUser) {
    const latestSynchronizationAt = getLatestHomeSynchronizationTimestamp(syncStatus);
    lines.push(
      "",
      "---",
      `Last Synchronisation: ${formatHomeSynchronizationTimestamp(latestSynchronizationAt, timezone)}`
    );
  }

  return lines.join("\n");
}

function buildAdminMenuDescription() {
  return [
    `Admin Menu (${BOT_VERSION})`,
    "",
    "Manage roster, onboarding, admins, and attendance.",
    "",
    "📋 Roster — Sync the roster and manage appointments.",
    "✉️ Send Invitation — Generate an invite for unregistered personnel.",
    "👮 Manage Admins — Add or remove admin appointments.",
    "📣 Prompt All — Send the attendance prompt to all bound users.",
    "🧩 Attendance Options — View and update the allowed attendance codes.",
    "🧾 Deregister Person — Remove a user’s Telegram binding and rotate their code.",
    "📤 Push Attendance — Flush all queued entries to Google Sheets immediately.",
    "📬 Outstanding — View attendance entries queued but not yet pushed."
  ].join("\n");
}

function getCanonicalAttendanceOptions(attendanceOptions, onboardingAttendanceOptions = []) {
  const displayOrderIndex = new Map(
    ATTENDANCE_OPTION_DISPLAY_ORDER.map((option, index) => [option, index])
  );
  const onboardingIndex = new Map(
    onboardingAttendanceOptions.map((option, index) => [option, index])
  );

  return [...attendanceOptions].sort((left, right) => {
    const leftDisplayIndex = displayOrderIndex.has(left)
      ? displayOrderIndex.get(left)
      : Number.MAX_SAFE_INTEGER;
    const rightDisplayIndex = displayOrderIndex.has(right)
      ? displayOrderIndex.get(right)
      : Number.MAX_SAFE_INTEGER;

    if (leftDisplayIndex !== rightDisplayIndex) {
      return leftDisplayIndex - rightDisplayIndex;
    }

    const leftOnboardingIndex = onboardingIndex.has(left)
      ? onboardingIndex.get(left)
      : Number.MAX_SAFE_INTEGER;
    const rightOnboardingIndex = onboardingIndex.has(right)
      ? onboardingIndex.get(right)
      : Number.MAX_SAFE_INTEGER;

    if (leftOnboardingIndex !== rightOnboardingIndex) {
      return leftOnboardingIndex - rightOnboardingIndex;
    }

    return left.localeCompare(right);
  });
}

function formatAttendanceOptionLine(option, width) {
  const description = ATTENDANCE_OPTION_DESCRIPTIONS[option];
  const padded = description
    ? option.padEnd(width, "\u00A0")
    : option;
  const code = `<code>${escapeHtml(padded)}</code>`;
  return description
    ? `${code} | ${escapeHtml(description)}`
    : code;
}

function buildAttendanceOptionsDescription(
  attendanceOptions,
  onboardingAttendanceOptions = [],
  attendanceGroups = []
) {
  const lines = [
    "Attendance Options",
    "",
    "These codes appear in the Telegram attendance prompt and in the Google Sheets dropdown.",
    "Defaults are loaded from settings.yaml. Changes made here are saved locally.",
    ""
  ];

  if (attendanceOptions.length === 0) {
    lines.push("No attendance options are currently configured.");
  } else if (Array.isArray(attendanceGroups) && attendanceGroups.length > 0) {
    lines.push(`Current options (${attendanceOptions.length}):`);

    for (const group of getAttendanceOptionGroups({ attendanceOptions, attendanceGroups })) {
      const visibleOptions = group.options;

      if (visibleOptions.length === 0) {
        continue;
      }

      lines.push("");
      lines.push(`${group.label}:`);
      lines.push(...visibleOptions.map((option) => formatAttendanceOptionLine(option, 0)));
    }
  } else {
    const canonicalOptions = getCanonicalAttendanceOptions(
      attendanceOptions,
      onboardingAttendanceOptions
    );
    const width = Math.max(
      ...canonicalOptions
        .filter((option) => Boolean(ATTENDANCE_OPTION_DESCRIPTIONS[option]))
        .map((option) => option.length),
      0
    );
    lines.push(`Current options (${attendanceOptions.length}):`);
    lines.push(...canonicalOptions.map((option) => formatAttendanceOptionLine(option, width)));
  }

  lines.push("");
  lines.push("Use the buttons below to add, remove, or reset to defaults.");
  return lines.join("\n");
}

function buildManageAdminsDescription(admins, activeCodes = [], defaultAdminAppointments = []) {
  const activeByAppointment = new Map(
    activeCodes.map((entry) => [entry.appointment.toUpperCase(), entry])
  );
  const adminByAppointment = new Map(
    admins.map((entry) => [entry.appointment.toUpperCase(), entry])
  );
  const lines = [
    "Manage Admins",
    "",
    "Current admin appointments:"
  ];

  const defaultRows = sortAppointmentsForAdmin(
    [...new Set(defaultAdminAppointments.map((appointment) => appointment.trim()).filter(Boolean))]
      .map((appointment) => ({ appointment: appointment.toUpperCase() }))
  ).map(({ appointment }) => {
    const normalized = appointment.toUpperCase();
    const activeEntry = activeByAppointment.get(normalized);
    return {
      appointment,
      source: "default",
      onboarded: Boolean(activeEntry?.boundChatId)
    };
  });
  const customRows = sortAppointmentsForAdmin(
    admins
      .filter((entry) => entry.source === "custom")
      .map((entry) => ({ appointment: entry.appointment }))
  ).map(({ appointment }) => ({
    appointment,
    source: "custom",
    onboarded: true
  }));
  const chiefRows = sortAppointmentsForAdmin(
    admins
      .filter((entry) => entry.source === "chief")
      .map((entry) => ({ appointment: entry.appointment }))
  ).map(({ appointment }) => ({
    appointment,
    source: "chief",
    onboarded: true
  }));
  const alreadyShownAppointments = new Set([
    ...defaultRows.map((e) => e.appointment.toUpperCase()),
    ...customRows.map((e) => e.appointment.toUpperCase())
  ]);
  const visibleRows = [
    ...defaultRows,
    ...customRows,
    ...chiefRows.filter((entry) => !alreadyShownAppointments.has(entry.appointment.toUpperCase()))
  ];

  if (visibleRows.length === 0) {
    lines.push("None");
  } else {
    lines.push(...visibleRows.map((entry) => {
      const onboardingStatus = entry.onboarded ? "registered" : "not registered";
      return `• ${entry.appointment} (${entry.source}, ${onboardingStatus})`;
    }));
  }

  lines.push("");
  lines.push("Use the buttons below to add or remove admin appointments.");
  return lines.join("\n");
}

function buildRosterDescription() {
  return [
    "Roster",
    "",
    "Keep the onboarding roster and attendance sheets aligned.",
    "",
    "🕓 Pending — Personnel who have not yet onboarded.",
    "🔄 Sync Roster — repair roster order, rows, and sheet layout.",
    "➕ Add Appointment — Add a new appointment and generate a registration code.",
    "➖ Remove Appointment — Remove an appointment and clear their Telegram binding.",
    "🔀 Transfer User — Move a registered user from one appointment slot to another.",
    "🔓 Clear All Protections — Remove all sheet protections from the spreadsheet.",
    "🔧 Self-Heal Logs — review automatic roster and cache repairs.",
    "📄 Change Spreadsheet — point the bot at another validated spreadsheet."
  ].join("\n");
}

function buildInvitationAdminDescription(pendingCount) {
  return [
    "Send Invitation",
    "",
    pendingCount === 1
      ? "1 person has not yet registered."
      : `${pendingCount} people have not yet registered.`,
    "Select a name to generate a forwardable invitation.",
    "",
    "💡 To remove someone from the roster entirely, use ➖ Remove Appointment instead."
  ].join("\n");
}

function getCachedSummarySnapshot(cache, config, date) {
  const snapshotVersion = cache.sheetSnapshots?.synchronizedAt ?? "none";
  const memoKey = `${snapshotVersion}:${toIsoDateString(date, config.timezone)}`;

  if (cache.summaryMemoVersion !== snapshotVersion) {
    cache.summaryMemo.clear();
    cache.summaryMemoVersion = snapshotVersion;
  }

  if (cache.summaryMemo.has(memoKey)) {
    return cache.summaryMemo.get(memoKey);
  }

  const summary = summarizeStatusesFromSnapshot(cache.sheetSnapshots, config, { date }) ?? null;

  if (summary) {
    cache.summaryMemo.set(memoKey, summary);
  }

  return summary;
}

function getUnaccountedAppointments(cache, config, date) {
  const month = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    month: "short"
  }).format(date);
  const year = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    year: "2-digit"
  }).format(date);
  const title = `${month} ${year}`;
  const snapshot = cache.sheetSnapshots?.snapshots?.get(title);

  if (!snapshot) {
    return [];
  }

  const day = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      day: "numeric"
    }).format(date)
  );
  const statuses = snapshot.statusesByDay.get(day) ?? [];

  return snapshot.appointments.filter((appointment, index) => !String(statuses[index] ?? "").trim());
}

async function renderCachedSummaryOrWarmup(ctx, cache, config, targetDate, backTarget = "admin:menu:roster") {
  const summary = getCachedSummarySnapshot(cache, config, targetDate);
  const hideUnaccounted = !(await isReminderWorkingDay(targetDate, config.timezone));

  if (summary) {
    await sendOrUpdateAdminMessage(
      ctx,
      formatSummaryMessage(summary, config, { hideUnaccounted }),
      buildSummaryMenu(targetDate, config.timezone, backTarget, {
        includeUnaccounted: !hideUnaccounted
      }),
      { parse_mode: "HTML" }
    );
    return true;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    [
      `Summary for ${formatAttendanceDateLabel(targetDate, config.timezone)} is warming up.`,
      "The cache is being refreshed in the background. Try again in a few seconds."
    ].join("\n"),
    buildSummaryMenu(targetDate, config.timezone, backTarget, {
      includeUnaccounted: !hideUnaccounted
    })
  );
  return false;
}

function buildChatUrlForRegistryEntry(entry) {
  if (entry?.boundUsername) {
    return `https://t.me/${entry.boundUsername}`;
  }

  return null;
}

function buildTodayAttendancePromptMessage(config, date, appointment = null, cache = null) {
  const label = formatAttendanceDateLabel(date, config.timezone);
  const existingStatus =
    appointment && cache ? getCachedAttendanceStatus(cache, config, appointment, date) : "";

  return existingStatus
    ? `Your attendance for ${label} is currently ${existingStatus}. Select new status.`
    : `Select your attendance for ${label}.`;
}

function formatSummaryMessage(summary, config, options = {}) {
  const counts = summary.summary;
  const asAt = summary.synchronizedAt ? new Date(summary.synchronizedAt) : new Date();
  const hideUnaccounted = options.hideUnaccounted === true;
  const rawCounts = new Map(summary.counts ?? []);
  const buildBreakdown = (statuses) => statuses
    .map((status) => ({
      status,
      count: Number(rawCounts.get(status) ?? 0)
    }))
    .filter((entry) => entry.count > 0);

  const lines = [
    `<b><u>Summary</u></b>`,
    `<b>${formatFullDateLabel(summary.date, config.timezone)}</b>`,
    `<i>Correct as at ${formatCorrectAsAt(asAt, config.timezone)}</i>`,
    "",
    `<b>Total:</b> ${counts.total}`,
    `<b>Accounted Attendance:</b> ${counts.accountedAttendance}`
  ];

  if (!hideUnaccounted) {
    lines.push(`<b>Unaccounted:</b> ${counts.unaccounted}`);
  }

  const configuredSections = Array.isArray(config.attendanceGroups) && config.attendanceGroups.length > 0
    ? (() => {
      const summaryOwnedOptions = new Set();
      const sections = config.attendanceGroups.map((group) => {
        const summaryCandidates = group.key === "OFF_LEAVE"
          ? [...group.options, "PCL", "PCL (AM)", "PCL (PM)", "PARENT CARE LEAVE"]
          : group.options;
        const ownedOptions = summaryCandidates.filter((option) => {
          if (summaryOwnedOptions.has(option)) return false;
          summaryOwnedOptions.add(option);
          return true;
        });
        return {
          heading: group.summaryLabel ?? group.label,
          total: ownedOptions.reduce(
            (sum, option) => sum + Number(rawCounts.get(option) ?? 0),
            0
          ),
          breakdown: buildBreakdown(ownedOptions)
        };
      });
      const otherBreakdown = [...rawCounts.entries()]
        .filter(([status, count]) => Number(count) > 0 && !summaryOwnedOptions.has(status))
        .map(([status, count]) => ({ status, count: Number(count) }));
      if (otherBreakdown.length > 0) {
        sections.push({
          heading: "Other",
          total: otherBreakdown.reduce((sum, entry) => sum + entry.count, 0),
          breakdown: otherBreakdown
        });
      }
      return sections;
    })()
    : [
      {
        heading: "Total PRESENT",
        total: counts.present,
        breakdown: buildBreakdown(["PRESENT", "DUTY"])
      },
      {
        heading: "PH",
        total: counts.ph,
        breakdown: buildBreakdown(["PH"])
      },
      {
        heading: "OSD",
        total: counts.osd,
        breakdown: buildBreakdown(["OSD"])
      },
      {
        heading: "OE",
        total: counts.oe,
        breakdown: buildBreakdown(["OE"])
      },
      {
        heading: "WFH",
        total: counts.wfh,
        breakdown: buildBreakdown(["WFH"])
      },
      {
        heading: "FISHING",
        total: counts.fishing,
        breakdown: buildBreakdown(["FISHING"])
      },
      {
        heading: "OFF",
        total: counts.off,
        breakdown: buildBreakdown(["OIL", "EMBARK OFF", "OFF", "DISEMBARK OFF", "RR", "SR"])
      },
      {
        heading: "Outstationed",
        total: counts.outstationed,
        breakdown: buildBreakdown(["OS", "TNB", "YARD", "ORCA"])
      },
      {
        heading: "Report Sick",
        total: counts.reportSick,
        breakdown: buildBreakdown(["RSO", "MC", "OML", "MA", "HL", "RSI"])
      },
      {
        heading: "Local Leave",
        total: counts.localLeave,
        breakdown: buildBreakdown(["LL", "CCL", "CSL", "COMPASSIONATE", "PTL", "PCL", "PCL (AM)", "PCL (PM)", "PARENT CARE LEAVE"])
      },
      {
        heading: "Overseas Leave",
        total: counts.overseasLeave,
        breakdown: buildBreakdown(["OL"])
      },
      {
        heading: "Attached Out",
        total: counts.attachedOut,
        breakdown: buildBreakdown(["AO", "68", "69", "70", "71", "73"])
      },
      {
        heading: "On Course",
        total: counts.onCourse,
        breakdown: buildBreakdown(["OC"])
      },
      {
        heading: "Posted Out",
        total: counts.postedOut,
        breakdown: buildBreakdown(["ORD", "POST OUT"])
      },
      {
        heading: "In Base",
        total: counts.inBase,
        breakdown: buildBreakdown(["IPPT", "FMSS", "CNB", "CST", "DCTC"])
      }
    ];

  for (const section of configuredSections) {
    lines.push("", `<b><u>${section.heading}:</u></b> ${section.total}`);

    if (section.breakdown.length === 0) {
      lines.push("None");
      continue;
    }

    lines.push(...section.breakdown.map((entry) => `${escapeHtml(entry.status)}: ${entry.count}`));
  }

  return lines.join("\n");
}

function createAdminCache() {
  return {
    syncManager: null,
    sheetSnapshots: null,
    summaryMemo: new Map(),
    summaryMemoVersion: null,
    pending: [],
    activeCodes: [],
    admins: [],
    inviteCandidates: [],
    deregisterCandidates: [],
    removeAppointmentCandidates: [],
    addAdminCandidates: [],
    removeAdminCandidates: [],
    transferFromCandidates: [],
    transferToCandidates: []
  };
}

const interactiveSheetOperations = [];
const backgroundSheetOperations = [];
let sheetOperationSchedulerRunning = false;
let runningSheetOperationPriority = null;
let releaseRequiredBackgroundSheetProgress = null;

async function drainSheetOperations() {
  if (sheetOperationSchedulerRunning) {
    return;
  }

  sheetOperationSchedulerRunning = true;
  try {
    while (interactiveSheetOperations.length > 0 || backgroundSheetOperations.length > 0) {
      const task = interactiveSheetOperations.shift() ?? backgroundSheetOperations.shift();
      runningSheetOperationPriority = task.priority;

      try {
        const value = task.priority === "interactive"
          ? await runWithInteractivePriority(task.operation)
          : await runWithBackgroundPriority(task.operation);
        task.resolve(value);
      } catch (error) {
        task.reject(error);
      } finally {
        if (task.priority === "background" && releaseRequiredBackgroundSheetProgress) {
          releaseRequiredBackgroundSheetProgress();
          releaseRequiredBackgroundSheetProgress = null;
        }
        runningSheetOperationPriority = null;
      }
    }
  } finally {
    sheetOperationSchedulerRunning = false;
    if (interactiveSheetOperations.length > 0 || backgroundSheetOperations.length > 0) {
      void drainSheetOperations();
    }
  }
}

function withSheetOperation(operation) {
  const priority = getCurrentWorkPriority() === "interactive"
    ? "interactive"
    : "background";

  return new Promise((resolve, reject) => {
    const task = { operation, priority, resolve, reject };
    if (priority === "interactive") {
      interactiveSheetOperations.push(task);
      if (
        runningSheetOperationPriority === "background" &&
        !releaseRequiredBackgroundSheetProgress
      ) {
        releaseRequiredBackgroundSheetProgress = requireBackgroundSheetProgress();
      }
    } else {
      backgroundSheetOperations.push(task);
    }
    void drainSheetOperations();
  });
}

function getTimezoneDateParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function getCurrentWeekDates(timezone, sourceDate = new Date()) {
  const dayMs = 24 * 60 * 60 * 1000;
  const { weekday, year, month, day } = getTimezoneDateParts(sourceDate, timezone);
  const weekdayOrder = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6
  };
  const offset = weekdayOrder[weekday] ?? 0;
  const currentLocalDate = new Date(Date.UTC(year, month - 1, day, 12));
  const monday = new Date(currentLocalDate.getTime() - offset * dayMs);

  return Array.from({ length: 7 }, (_, index) =>
    new Date(monday.getTime() + index * dayMs).toISOString()
  );
}

function getCurrentWorkweekDates(timezone, sourceDate = new Date()) {
  return getCurrentWeekDates(timezone, sourceDate).slice(0, 5);
}

function getWorkweekDates(timezone, weekOffset = 0, sourceDate = new Date()) {
  const shiftedSourceDate = shiftDate(sourceDate, weekOffset * 7);
  return getCurrentWorkweekDates(timezone, shiftedSourceDate);
}

function formatWeekDateLabel(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short"
  }).format(date);
}

function toIsoDateString(date, timezone) {
  const parts = getTimezoneDateParts(date, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}


async function isReminderWorkingDay(date, timezone) {
  if (getWeekdayIndex(timezone, date) >= 5) {
    return false;
  }

  const isoDate = toIsoDateString(date, timezone);
  const holidaySet = await getSingaporePublicHolidaySet(Number(isoDate.slice(0, 4)));
  return !holidaySet.has(isoDate);
}

async function clearWeeklyAttendanceState(ctx) {
  ctx.session.awaitingWeeklyAttendance = false;
  ctx.session.weeklyAttendanceDates = [];
  ctx.session.weeklyAttendanceIndex = 0;
  ctx.session.weeklyAttendanceResults = [];
  ctx.session.weeklyAttendanceEntries = [];
  ctx.session.weeklyAttendanceFlowId = null;
  await updateUserByChatId(ctx.chat.id, {
    awaitingWeeklyAttendance: false,
    weeklyAttendanceDates: [],
    weeklyAttendanceIndex: 0,
    weeklyAttendanceResults: [],
    weeklyAttendanceEntries: [],
    weeklyAttendanceFlowId: null
  });
}

function getWeeklyAttendanceState(ctx, user) {
  const hasSessionFlow =
    Array.isArray(ctx.session.weeklyAttendanceDates) &&
    ctx.session.weeklyAttendanceDates.length > 0;

  const state = {
    dates: hasSessionFlow
      ? ctx.session.weeklyAttendanceDates
      : Array.isArray(user?.weeklyAttendanceDates)
        ? user.weeklyAttendanceDates
        : [],
    index: hasSessionFlow
      ? Number(ctx.session.weeklyAttendanceIndex ?? 0)
      : Number(user?.weeklyAttendanceIndex ?? 0),
    entries: hasSessionFlow
      ? (Array.isArray(ctx.session.weeklyAttendanceEntries)
          ? ctx.session.weeklyAttendanceEntries
          : [])
      : Array.isArray(user?.weeklyAttendanceEntries)
        ? user.weeklyAttendanceEntries
        : [],
    flowId: hasSessionFlow
      ? ctx.session.weeklyAttendanceFlowId
      : user?.weeklyAttendanceFlowId ?? null
  };
  if (!state.flowId) {
    delete state.flowId;
  }
  return state;
}

function restoreWeeklyAttendanceSession(ctx, state) {
  ctx.session.awaitingWeeklyAttendance = true;
  ctx.session.weeklyAttendanceDates = state.dates;
  ctx.session.weeklyAttendanceIndex = state.index;
  ctx.session.weeklyAttendanceEntries = state.entries;
  ctx.session.weeklyAttendanceFlowId = state.flowId ?? null;
}

async function finalizeWeeklyAttendanceFlow(ctx, config, user, cache) {
  const appointment = user?.appointment;
  const weeklyState = getWeeklyAttendanceState(ctx, user);
  const dates = weeklyState.dates;
  const stagedEntries = weeklyState.entries;

  if (!appointment || dates.length === 0) {
    await clearWeeklyAttendanceState(ctx);
    await sendOrUpdateAdminMessage(
      ctx,
      "Weekly attendance flow expired. Run /week to start again.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "home:main"),
          Markup.button.callback("❌ Close", "home:close")
        ]
      ])
    );
    return false;
  }

  const resolvedEntries = resolveWeeklyAttendanceEntries(
    dates,
    stagedEntries,
    (date) => getCachedAttendanceStatus(cache, config, appointment, date),
    (value) => toIsoDateString(value, config.timezone)
  );
  const missingEntries = resolvedEntries.filter((entry) => !entry.status);

  if (missingEntries.length > 0) {
    // Restore persisted state into the in-memory session after a restart so
    // the user can complete the missing days without beginning again.
    restoreWeeklyAttendanceSession(ctx, weeklyState);
    const missingLabels = missingEntries.map((entry) =>
      formatWeekDateLabel(new Date(`${entry.date}T12:00:00.000Z`), config.timezone)
    );
    const { message, keyboard } = buildWeeklyAttendanceOverview(
      dates,
      stagedEntries,
      cache,
      config,
      user,
      weeklyState.flowId
    );

    await sendOrUpdateAdminMessage(
      ctx,
      [
        `Select attendance for every weekday before submitting. Missing: ${missingLabels.join(", ")}.`,
        "",
        message
      ].join("\n"),
      keyboard
    );
    return false;
  }

  const queuedEntries = resolvedEntries.map((entry) => {
    const date = new Date(`${entry.date}T12:00:00.000Z`);
    return {
      appointment,
      status: entry.status,
      date,
      source: "weekly",
      idempotencyKey: buildWeeklyAttendanceIdempotencyKey(
        weeklyState.flowId,
        appointment,
        entry.date,
        entry.status
      ),
      ...buildQueuedAttendanceEventMetadata(cache.sheetSnapshots, config, {
        appointment,
        status: entry.status,
        date
      })
    };
  });
  await enqueueAttendanceEvents(config, queuedEntries);
  runWithBackgroundPriority(() =>
    triggerAttendanceQueueThresholdFlush(cache)
  ).catch((error) => {
    logBotError("Threshold attendance flush check failed.", { error: error.message });
  });

  if (cache.sheetSnapshots) {
    cache.sheetSnapshots = applyAttendanceEntriesToSnapshotBundle(
      cache.sheetSnapshots,
      config,
      queuedEntries
    );
    cache.summaryMemo.clear();
    cache.summaryMemoVersion = cache.sheetSnapshots?.synchronizedAt ?? null;
  }

  const results = resolvedEntries.map((entry) => {
    const date = new Date(`${entry.date}T12:00:00.000Z`);
    return `${formatWeekDateLabel(date, config.timezone)}: ${entry.status}`;
  });

  await clearWeeklyAttendanceState(ctx);
  // A completed weekly flow can reuse an earlier confirmation message. Wait
  // for any old cleanup edit to finish before installing the new keyboard.
  await cancelAttendanceButtonCleanup(
    ctx.chat.id,
    getMessageId(ctx.callbackQuery?.message)
  ).catch((error) => {
    logBotError("Failed to cancel prior weekly confirmation button cleanup.", {
      error: error.message
    });
  });
  const latestUser = await getUserByChatId(ctx.chat.id);
  const confirmationMessage = await sendOrUpdateAdminMessage(
    ctx,
    [
      `Weekly attendance recorded for all ${resolvedEntries.length} weekdays and queued for Google Sheets sync:`,
      "",
      ...results
    ].join("\n"),
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🔙 Back", "home:main"),
        Markup.button.callback("❌ Close", "home:close")
      ]
    ])
  );
  const currentMessageId = getMessageId(confirmationMessage) ??
    getMessageId(ctx.callbackQuery?.message);
  await Promise.all([
    updateUserByChatId(ctx.chat.id, { weeklyPromptMessageIds: [] }),
    scheduleAttendanceButtonCleanup(
      ctx.chat.id,
      currentMessageId,
      new Date()
    ).catch((error) => {
      logBotError("Failed to schedule weekly confirmation button cleanup.", {
        error: error.message
      });
    }),
    removeObsoleteAttendancePromptMessages(
      ctx.telegram,
      ctx.chat.id,
      latestUser?.weeklyPromptMessageIds,
      currentMessageId
    )
  ]);
  return true;
}

async function submitGitHubIssue(title, body) {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    return { ok: false, reason: "no_token" };
  }

  let response;

  try {
    response = await fetch("https://api.github.com/repos/Joncallim/stl_attendance_bot/issues", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({ title, body })
    });
  } catch (error) {
    logBotError("[GitHub] fetch failed.", { error: error.message });
    return { ok: false, reason: `network_error:${error.message}` };
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    logBotError("[GitHub] API error.", { status: response.status, body: responseText });
    return { ok: false, reason: `github_api_error:${response.status}` };
  }

  const data = await response.json();
  return { ok: true, issueNumber: data.number, issueUrl: data.html_url };
}

/**
 * Updates GOOGLE_SHEETS_SPREADSHEET_ID in the .env file on disk and in
 * the live config object.  The file path is read from ENV_FILE_PATH, falling
 * back to ".env" in the process working directory.
 *
 * Returns { ok: true } on success, or { ok: false, reason } on failure.
 */
async function updateEnvSpreadsheetId(newSpreadsheetId, config) {
  const envPath = process.env.ENV_FILE_PATH ?? path.resolve(process.cwd(), ".env");

  let content;

  try {
    content = await readFile(envPath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      logBotError("[SpreadsheetChange] .env file not found.", { path: envPath });
      return { ok: false, reason: "env_file_not_found", path: envPath };
    }
    logBotError("[SpreadsheetChange] Failed to read .env file.", { error: error.message });
    return { ok: false, reason: error.message };
  }

  const lineRegex = /^GOOGLE_SHEETS_SPREADSHEET_ID=.*/m;
  const newLine = `GOOGLE_SHEETS_SPREADSHEET_ID=${newSpreadsheetId}`;

  let updated;

  if (lineRegex.test(content)) {
    updated = content.replace(lineRegex, newLine);
  } else {
    // Key is absent — append it.
    updated = content.trimEnd() + `\n${newLine}\n`;
  }

  try {
    await writePrivateTextFile(envPath, updated);
  } catch (error) {
    logBotError("[SpreadsheetChange] Failed to write .env file.", { error: error.message });
    return { ok: false, reason: error.message };
  }

  // Apply to the live config so subsequent API calls use the new spreadsheet immediately.
  config.spreadsheetId = newSpreadsheetId;
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = newSpreadsheetId;

  logBot("[SpreadsheetChange] Spreadsheet ID updated.", { newSpreadsheetId });
  return { ok: true };
}

async function resetConversationState(ctx) {
  cancelInteractions(ctx);
  ctx.session.awaitingAttendance = false;
  ctx.session.awaitingSecretCode = false;
  ctx.session.awaitingAttendanceOptionAdd = false;
  ctx.session.awaitingAppointmentAdd = false;
  ctx.session.awaitingIssueReport = false;
  ctx.session.awaitingSpreadsheetIdChange = false;
  ctx.session.departmentEditTarget = null;
  ctx.session.awaitingWeeklyAttendance = false;
  ctx.session.weeklyAttendanceDates = [];
  ctx.session.weeklyAttendanceIndex = 0;
  ctx.session.weeklyAttendanceResults = [];
  ctx.session.weeklyAttendanceEntries = [];
  ctx.session.weeklyAttendanceFlowId = null;
  await updateUserByChatId(ctx.chat.id, {
    awaitingAttendance: false,
    awaitingSecretCode: false,
    awaitingWeeklyAttendance: false,
    weeklyAttendanceDates: [],
    weeklyAttendanceIndex: 0,
    weeklyAttendanceResults: [],
    weeklyAttendanceEntries: [],
    weeklyAttendanceFlowId: null
  });
}

async function askForSecretCode(ctx, config) {
  cancelInteractions(ctx);
  await clearWeeklyAttendanceState(ctx);
  ctx.session.awaitingSecretCode = true;
  await updateUserByChatId(ctx.chat.id, {
    awaitingSecretCode: true
  });
  await ctx.reply(ONBOARDING_CODE_PROMPT, Markup.removeKeyboard());
}

async function askAttendance(ctx, config, user = null, cache = null) {
  cancelInteractions(ctx);
  ctx.session.awaitingAttendance = true;
  ctx.session.awaitingWeeklyAttendance = false;
  ctx.session.weeklyAttendanceDates = [];
  ctx.session.weeklyAttendanceIndex = 0;
  ctx.session.weeklyAttendanceResults = [];
  ctx.session.weeklyAttendanceEntries = [];
  ctx.session.weeklyAttendanceFlowId = null;
  const date = new Date();
  const promptId = newAttendancePromptId();
  const message = buildTodayAttendancePromptMessage(
    config,
    date,
    user?.appointment ?? null,
    cache
  );
  const promptMessage = await sendOrUpdateAdminMessage(
    ctx,
    message,
    buildDatedAttendanceMenu(
      config,
      date,
      0,
      "home:pick:attendance",
      "home:attendance:page",
      "home:main",
      [],
      {
        promptId,
        groupCallbackBuilder: (groupKey, isoDate, prompt) =>
          `home:attendance:groups:${prompt}:${isoDate}:${groupKey}`
      }
    )
  );
  const messageId = getMessageId(promptMessage) ??
    getMessageId(ctx.callbackQuery?.message);

  await updateUserByChatId(ctx.chat.id, {
    awaitingAttendance: true,
    awaitingWeeklyAttendance: false,
    weeklyAttendanceDates: [],
    weeklyAttendanceIndex: 0,
    weeklyAttendanceResults: [],
    weeklyAttendanceEntries: [],
    weeklyAttendanceFlowId: null,
    promptedAt: new Date().toISOString(),
    attendancePromptMessageIds: appendAttendancePromptMessageId(user, messageId)
  });
}

function buildWeeklyAttendanceOverview(weeklyDates, weeklyEntries, cache, config, user, flowId = "expired") {
  const appointment = user?.appointment;
  const dayLines = weeklyDates.map((dateValue) => {
    const date = new Date(dateValue);
    const label = formatAttendanceDateLabel(date, config.timezone);
    const staged = getStagedAttendanceStatus(weeklyEntries, dateValue, (v) => toIsoDateString(v, config.timezone));
    const cached = appointment ? getCachedAttendanceStatus(cache, config, appointment, date) : "";
    const status = staged || cached || "—";
    return `${label}: ${status}`;
  });

  const message = [
    "Weekly attendance update",
    "Public holidays are prefilled as PH.",
    "Every weekday must have a status before submission.",
    "",
    ...dayLines,
    "",
    "Tap a day below to update it, then press Submit when done."
  ].join("\n");

  const dayButtons = weeklyDates.map((dateValue) => {
    const date = new Date(dateValue);
    const isoDate = toIsoDateString(date, config.timezone);
    const shortLabel = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone,
      weekday: "short",
      day: "numeric"
    }).format(date);
    const staged = getStagedAttendanceStatus(weeklyEntries, dateValue, (v) => toIsoDateString(v, config.timezone));
    const cached = appointment ? getCachedAttendanceStatus(cache, config, appointment, date) : "";
    const status = staged || cached || "—";
    return Markup.button.callback(`${shortLabel}: ${status}`, `home:week:day:${flowId}:${isoDate}`);
  });

  const rows = [];

  for (let i = 0; i < dayButtons.length; i += 2) {
    rows.push(dayButtons.slice(i, i + 2));
  }

  const weekId = weeklyDates[0]
    ? toIsoDateString(new Date(weeklyDates[0]), config.timezone)
    : "expired";
  rows.push([Markup.button.callback("✅ Submit", `home:week:submit:${flowId}:${weekId}`)]);
  rows.push([
    Markup.button.callback("🔙 Back", "home:main"),
    Markup.button.callback("❌ Close", "home:close")
  ]);

  return { message, keyboard: Markup.inlineKeyboard(rows) };
}

async function showWeeklyAttendanceOverview(ctx, config, user, cache) {
  const weeklyState = getWeeklyAttendanceState(ctx, user);

  if (weeklyState.dates.length > 0 && !weeklyState.flowId) {
    weeklyState.flowId = randomBytes(8).toString("base64url");
  }

  if (weeklyState.dates.length > 0) {
    restoreWeeklyAttendanceSession(ctx, weeklyState);
  }

  const { message, keyboard } = buildWeeklyAttendanceOverview(
    weeklyState.dates,
    weeklyState.entries,
    cache,
    config,
    user,
    weeklyState.flowId
  );
  const promptMessage = await sendOrUpdateAdminMessage(ctx, message, keyboard);
  const messageId = getMessageId(promptMessage) ??
    getMessageId(ctx.callbackQuery?.message);
  const latestUser = await getUserByChatId(ctx.chat.id);
  await updateUserByChatId(ctx.chat.id, {
    ...(weeklyState.dates.length > 0
      ? { weeklyAttendanceFlowId: weeklyState.flowId }
      : {}),
    weeklyPromptMessageIds: appendAttendancePromptMessageId(
      { attendancePromptMessageIds: latestUser?.weeklyPromptMessageIds },
      messageId
    )
  });
}

async function promptWeeklyAttendanceDay(ctx, config, user, cache, page = 0) {
  const weeklyState = getWeeklyAttendanceState(ctx, user);
  const dateValue = weeklyState.dates[weeklyState.index];

  if (!dateValue) {
    return;
  }

  restoreWeeklyAttendanceSession(ctx, weeklyState);
  const date = new Date(dateValue);
  const isoDate = toIsoDateString(date, config.timezone);
  const label = formatAttendanceDateLabel(date, config.timezone);
  const stagedStatus = getStagedAttendanceStatus(
    weeklyState.entries,
    date,
    (value) => toIsoDateString(value, config.timezone)
  );
  const existingStatus = stagedStatus || (user?.appointment
    ? getCachedAttendanceStatus(cache, config, user.appointment, date)
    : "");
  const detailLine = existingStatus
    ? `Your attendance for ${label} is currently ${existingStatus}. Select new status or skip.`
    : `Select attendance for ${label}.`;
  const message = [
    "Weekly attendance update",
    "Public holidays are prefilled as PH. Use Skip only to keep an existing entry unchanged.",
    "Every weekday must have a status before submission.",
    "",
    detailLine
  ].join("\n");
  const promptMessage = await sendOrUpdateAdminMessage(
    ctx,
    message,
    buildDatedAttendanceMenu(
      config,
      date,
      page,
      `home:pick:week:${weeklyState.flowId}`,
      `home:week:page:${weeklyState.flowId}`,
      `home:week:overview:${weeklyState.flowId}:${toIsoDateString(new Date(weeklyState.dates[0]), config.timezone)}`,
      [[Markup.button.callback(WEEK_SKIP_LABEL, `home:pick:week:${weeklyState.flowId}:${isoDate}:skip`)]],
      {
        groupCallbackBuilder: (groupKey, requestedDate) =>
          `home:week:groups:${weeklyState.flowId}:${requestedDate}:${groupKey}`
      }
    )
  );
  const messageId = getMessageId(promptMessage) ??
    getMessageId(ctx.callbackQuery?.message);
  const latestUser = await getUserByChatId(ctx.chat.id);
  await updateUserByChatId(ctx.chat.id, {
    weeklyPromptMessageIds: appendAttendancePromptMessageId(
      { attendancePromptMessageIds: latestUser?.weeklyPromptMessageIds },
      messageId
    )
  });
}

async function autoFillWeeklyPublicHolidays(ctx, config, sheets, user, cache) {
  const weeklyDates = ctx.session.weeklyAttendanceDates ?? [];
  const weeklyEntries = Array.isArray(ctx.session.weeklyAttendanceEntries)
    ? [...ctx.session.weeklyAttendanceEntries]
    : [];

  for (const dateValue of weeklyDates) {
    const date = new Date(dateValue);
    const isoDate = toIsoDateString(date, config.timezone);
    const holidaySet = await getSingaporePublicHolidaySet(
      Number(isoDate.slice(0, 4))
    );

    if (!holidaySet.has(isoDate)) {
      continue;
    }

    if (
      !getStagedAttendanceStatus(weeklyEntries, isoDate, (value) => toIsoDateString(value, config.timezone)) &&
      !getCachedAttendanceStatus(cache, config, user.appointment, date)
    ) {
      weeklyEntries.push({ date: isoDate, status: "PH" });
    }
  }

  ctx.session.weeklyAttendanceEntries = weeklyEntries;

  await updateUserByChatId(ctx.chat.id, {
    weeklyAttendanceEntries: weeklyEntries,
    lastSubmittedAt: weeklyEntries.length > 0 ? new Date().toISOString() : undefined
  });
}

async function startWeeklyAttendanceFlow(ctx, config, sheets, user, cache, weekOffset = 0) {
  cancelInteractions(ctx);
  const weeklyState = createWeeklyFlowState(getWorkweekDates(config.timezone, weekOffset));

  ctx.session.awaitingAttendance = false;
  ctx.session.awaitingWeeklyAttendance = weeklyState.awaitingWeeklyAttendance;
  ctx.session.weeklyAttendanceDates = weeklyState.weeklyAttendanceDates;
  ctx.session.weeklyAttendanceIndex = weeklyState.weeklyAttendanceIndex;
  ctx.session.weeklyAttendanceResults = weeklyState.weeklyAttendanceResults;
  ctx.session.weeklyAttendanceEntries = weeklyState.weeklyAttendanceEntries;
  ctx.session.weeklyAttendanceFlowId = randomBytes(8).toString("base64url");

  await updateUserByChatId(ctx.chat.id, {
    awaitingAttendance: false,
    ...weeklyState,
    weeklyAttendanceFlowId: ctx.session.weeklyAttendanceFlowId
  });

  // Public-holiday metadata is normally cached, but the first-ever load can
  // take several seconds while data.gov.sg responds. Never make the user wait
  // for that network call before seeing the weekly menu.
  await showWeeklyAttendanceOverview(ctx, config, user, cache);

  const flowId = ctx.session.weeklyAttendanceFlowId;
  void autoFillWeeklyPublicHolidays(ctx, config, sheets, user, cache)
    .then(async () => {
      if (
        ctx.session.weeklyAttendanceFlowId !== flowId ||
        ctx.session.awaitingWeeklyAttendance !== true ||
        Number(ctx.session.weeklyAttendanceIndex ?? 0) !== 0
      ) {
        return;
      }
      await showWeeklyAttendanceOverview(ctx, config, user, cache);
    })
    .catch((error) => {
      logBotWarn("Weekly public-holiday prefill deferred; the weekly menu remains usable.", {
        error: error.message,
        flowId
      });
    });
}

async function registerUser(ctx) {
  const from = ctx.from;

  if (
    ctx.chat?.type !== "private" ||
    !from?.id ||
    String(ctx.chat.id) !== String(from.id)
  ) {
    throw new Error("Telegram identity validation failed.");
  }

  await upsertUser({
    chatId: String(ctx.chat.id),
    userId: String(from.id),
    username: from.username || "",
    firstName: from.first_name || "",
    lastName: from.last_name || "",
    fullName: formatUserName(from),
    awaitingAttendance: false,
    awaitingSecretCode: false,
    updatedAt: new Date().toISOString()
  });
}

function getCommandArgument(text, commandName) {
  return text.replace(new RegExp(`^/${commandName}(@\\w+)?`, "i"), "").trim();
}

/**
 * Returns true if the user behind `ctx` has admin access.
 * Admin status is granted through three routes (any one is sufficient):
 *   1. The appointment appears in settings.yaml with `defaultAdmin: true`.
 *   2. The appointment was manually added via "Add Admin".
 *   3. The appointment is a department chief (C/Chief prefix → roleOrder 0).
 */
async function isAdmin(ctx, config) {
  const user = await getUserByChatId(ctx.chat.id);

  if (
    !user?.appointment ||
    !ctx.from?.id ||
    String(user.userId) !== String(ctx.from.id)
  ) {
    return false;
  }

  // Route 3 — department chiefs are always admins.
  if (isChiefAppointment(user.appointment)) {
    return true;
  }

  const adminAppointments = await listAdminAppointments(config.defaultAdminAppointments);
  return adminAppointments.some(
    (entry) => entry.appointment.toUpperCase() === user.appointment.toUpperCase()
  );
}


async function requireAdmin(ctx, config) {
  if (await isAdmin(ctx, config)) {
    return true;
  }

  await ctx.reply("You are not allowed to use this admin command.");
  return false;
}

async function renderHomeMenu(ctx, config, options = {}) {
  const user = options.user ?? (await getUserByChatId(ctx.chat.id));
  const isAdminUser = options.isAdminUser ?? (await isAdmin(ctx, config));
  const greeting = getGreetingForTime(config.timezone);
  const name = user?.appointment || "there";
  const syncStatus = options.syncStatus ?? options.cache?.syncManager?.getStatus() ?? null;
  const text = buildHomeMenuText({
    greeting,
    name,
    isAdminUser,
    timezone: config.timezone,
    syncStatus
  });

  await sendOrUpdateAdminMessage(ctx, text, buildHomeMenu(isAdminUser, config.timezone));
}

async function renderDepartmentView(ctx, config, cache, viewer, options = {}) {
  const viewModel = buildDepartmentWorkweekViewModel(cache, config, viewer, options);

  if (!viewModel.ok) {
    const messages = {
      not_bound: "You are not currently bound to an appointment.",
      unclassified: "Your appointment is not currently mapped to a department.",
      unknown_department: "That department is not available."
    };
    await sendOrUpdateAdminMessage(
      ctx,
      messages[viewModel.reason] || "Unable to open the department view.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "home:main"),
          Markup.button.callback("❌ Close", "home:close")
        ]
      ])
    );
    return null;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    [
      options.banner ? `<i>${escapeHtml(options.banner)}</i>` : null,
      formatDepartmentViewMessage(viewModel, config.timezone)
    ].filter(Boolean).join("\n\n"),
    buildDepartmentMenu(viewModel),
    { parse_mode: "HTML" }
  );
  return viewModel;
}

async function queueAttendanceSelection(cache, config, appointment, status, date, source, idempotencyKey = null) {
  const queuedEntry = {
    appointment,
    status,
    date,
    source,
    idempotencyKey,
    ...buildQueuedAttendanceEventMetadata(cache.sheetSnapshots, config, {
      appointment,
      status,
      date
    })
  };

  await enqueueAttendanceEvent(config, queuedEntry);
  runWithBackgroundPriority(() =>
    triggerAttendanceQueueThresholdFlush(cache)
  ).catch((error) => {
    logBotError("Threshold attendance flush check failed.", { error: error.message });
  });

  if (cache.sheetSnapshots) {
    cache.sheetSnapshots = applyAttendanceEntriesToSnapshotBundle(
      cache.sheetSnapshots,
      config,
      [queuedEntry]
    );
    cache.summaryMemo.clear();
    cache.summaryMemoVersion = cache.sheetSnapshots?.synchronizedAt ?? null;
  }

  return queuedEntry;
}

async function triggerAttendanceQueueThresholdFlush(cache, deps = {}) {
  const listPendingAttendanceEventsFn =
    deps.listPendingAttendanceEventsFn ?? listPendingAttendanceEvents;
  const pendingEvents = await listPendingAttendanceEventsFn();

  if (pendingEvents.length < ATTENDANCE_QUEUE_FLUSH_THRESHOLD) {
    return false;
  }

  const syncManager = cache?.syncManager;
  if (!syncManager) {
    return false;
  }

  await syncManager.runCycle({
    force: true,
    flushQueue: true,
    reason: "queue-threshold"
  });
  return true;
}

function buildRegistrySheetReconciliationOptions(registry) {
  return {
    appointmentsToRestore: (registry.appointments ?? [])
      .filter((entry) =>
        !entry.removedByBotAt && (entry.active || (!entry.active && entry.boundChatId))
      )
      .map((entry) => entry.appointment),
    appointmentsToRemove: (registry.appointments ?? [])
      .filter((entry) => entry.removedByBotAt)
      .map((entry) => entry.appointment)
  };
}

async function syncRosterState(sheets, config) {
  // Re-read settings.yaml before every sync so admin edits (new appointments,
  // reordered hierarchy, updated officer types) are picked up without restart.
  await applyStoredConfigOverrides();

  // Reconcile by union: any active main-registry appointment missing from
  // Google ONBOARDING is restored. Automatic removal is allowed only when the
  // bot recorded an explicit removal tombstone.
  const preRegistry = await getAppointmentRegistry();
  const reconciliationOptions = buildRegistrySheetReconciliationOptions(preRegistry);

  // forceMetadata: true busts the 45-minute process-level spreadsheet metadata
  // cache so that externally renamed or added sheets are picked up immediately.
  const roster = await syncOnboardingRoster(sheets, config, {
    ...reconciliationOptions,
    forceMetadata: true
  });

  if (roster.driftDetected) {
    return roster;
  }

  const registry = await syncAppointmentRegistry(roster.onboardingAppointments);
  await syncOnboardingCodeColumn(
    sheets,
    config,
    registry.appointments.filter((entry) => entry.active)
  );
  return { ...roster, integrity: registry.integrity };
}

async function preloadSheetSnapshots(sheets, config, cache, options = {}) {
  const snapshotBundle = await preloadAttendanceSnapshots(sheets, config, options);
  const pendingEvents = await listUnresolvedAttendanceEvents();
  const pendingEntries = pendingEvents.map((event) => ({
    appointment: event.appointment,
    status: event.status,
    date: new Date(`${event.date}T12:00:00.000Z`)
  }));

  cache.sheetSnapshots = pendingEntries.length > 0
    ? applyAttendanceEntriesToSnapshotBundle(snapshotBundle, config, pendingEntries)
    : snapshotBundle;
  cache.summaryMemo.clear();
  cache.summaryMemoVersion = cache.sheetSnapshots?.synchronizedAt ?? null;

  return cache.sheetSnapshots;
}

async function refreshAdminCache(cache, config) {
  const settings = await getSettings();

  if (Array.isArray(settings.attendanceOptions) && settings.attendanceOptions.length > 0) {
    config.attendanceOptions = settings.attendanceOptions;
  }

  const [registry, admins] = await Promise.all([
    getAppointmentRegistry(),
    listAdminAppointments(config.defaultAdminAppointments)
  ]);
  // Merge manually-granted and default admins with auto-chief admins so that
  // department chiefs show in the admin list UI without needing manual grants.
  const adminAppointmentSet = new Set(admins.map((e) => e.appointment.toUpperCase()));

  // Single pass over all appointments — avoids 7 separate filter/map chains.
  const activeCodes = [];
  const pending = [];
  const chiefAdmins = [];
  const inviteCandidates = [];
  const deregisterCandidates = [];
  const removeAppointmentCandidates = [];
  const transferFromCandidates = [];
  const transferToCandidates = [];

  for (const entry of registry.appointments) {
    if (!entry.active) continue;
    activeCodes.push(entry);
    const boundFullName = entry.boundFullName || null;
    const boundChatId = entry.boundChatId || null;
    const label = {
      label: boundFullName
        ? `${entry.appointment} — ${boundFullName}`
        : entry.appointment,
      appointment: entry.appointment,
      stateIdentity: getAppointmentStateIdentity(entry),
      boundFullName,
      boundChatId
    };
    removeAppointmentCandidates.push(label);
    if (entry.boundChatId) {
      const bindingIdentity = getAppointmentBindingIdentity(entry);
      deregisterCandidates.push({ ...label, bindingIdentity });
      transferFromCandidates.push({
        label: boundFullName
          ? `${entry.appointment} — ${boundFullName}`
          : entry.appointment,
        appointment: entry.appointment,
        bindingIdentity,
        boundFullName,
        boundChatId
      });
      if (isChiefAppointment(entry.appointment) && !adminAppointmentSet.has(entry.appointment.toUpperCase())) {
        chiefAdmins.push({ appointment: entry.appointment, source: "chief" });
      }
    } else {
      pending.push(entry);
      inviteCandidates.push({ ...label, expectedStateIdentity: getAppointmentStateIdentity(entry) });
      transferToCandidates.push(label);
    }
  }

  const allAdmins = [...admins, ...chiefAdmins];
  const adminSet = new Set(allAdmins.map((e) => e.appointment.toUpperCase()));
  const activeCodeByAppointment = new Map(
    activeCodes.map((entry) => [entry.appointment.toUpperCase(), entry])
  );

  // Chiefs are already admins — exclude them from the "add admin" list.
  const addAdminCandidates = activeCodes
    .filter((entry) => !adminSet.has(entry.appointment.toUpperCase()))
    .map((entry) => ({
      label: entry.boundFullName
        ? `${entry.appointment} — ${entry.boundFullName}`
        : entry.appointment,
      appointment: entry.appointment,
      bindingIdentity: getAppointmentBindingIdentity(entry),
      boundFullName: entry.boundFullName || null,
      boundChatId: entry.boundChatId || null
    }));
  const removeAdminCandidates = allAdmins
    .filter((entry) => entry.source === "custom")
    .map((entry) => {
      const target = activeCodeByAppointment.get(entry.appointment.toUpperCase());
      return {
        label: target?.boundFullName
          ? `${entry.appointment} — ${target.boundFullName}`
          : entry.appointment,
        appointment: entry.appointment,
        bindingIdentity: getAppointmentBindingIdentity(target),
        boundFullName: target?.boundFullName || null
      };
    });

  cache.activeCodes = activeCodes;
  cache.pending = pending;
  cache.admins = allAdmins;
  cache.inviteCandidates = inviteCandidates;
  cache.deregisterCandidates = deregisterCandidates;
  cache.removeAppointmentCandidates = removeAppointmentCandidates;
  cache.addAdminCandidates = addAdminCandidates;
  cache.removeAdminCandidates = removeAdminCandidates;
  cache.transferFromCandidates = transferFromCandidates;
  cache.transferToCandidates = transferToCandidates;

  cache.inviteCandidates = sortAppointmentsForAdmin(cache.inviteCandidates, config);
  cache.deregisterCandidates = sortAppointmentsForAdmin(cache.deregisterCandidates, config);
  cache.removeAppointmentCandidates = sortAppointmentsForAdmin(cache.removeAppointmentCandidates, config);
  cache.addAdminCandidates = sortAppointmentsForAdmin(cache.addAdminCandidates, config);
  cache.removeAdminCandidates = sortAppointmentsForAdmin(cache.removeAdminCandidates, config);
  cache.transferFromCandidates = sortAppointmentsForAdmin(cache.transferFromCandidates, config);
  cache.transferToCandidates = sortAppointmentsForAdmin(cache.transferToCandidates, config);
}

async function ensureSheetReadiness(sheets, config, cache, options = {}) {
  const force = options.force === true;
  const hasWarmCache =
    cache.activeCodes.length > 0 || cache.admins.length > 0 || cache.sheetSnapshots !== null;
  const syncStatus = cache.syncManager?.getStatus() ?? {
    lastOnboardingRefreshAt: 0,
    lastMonthRefreshAt: 0,
    lastFiveMinuteReconcileAt: 0,
    cycleInProgress: false
  };
  const lastMeaningfulSyncAt = Math.max(
    syncStatus.lastOnboardingRefreshAt ?? 0,
    syncStatus.lastMonthRefreshAt ?? 0
  );
  const isFresh = Date.now() - lastMeaningfulSyncAt < 60_000;

  if (!force && hasWarmCache && isFresh) {
    return;
  }

  if (!cache.syncManager) {
    await syncRosterState(sheets, config);
    await refreshAdminCache(cache, config);
    await preloadSheetSnapshots(sheets, config, cache, { force: true });
    return;
  }

  if (!force) {
    if (!syncStatus.cycleInProgress) {
      runWithBackgroundPriority(() =>
        cache.syncManager.runCycle({ force: false, reason: "background" })
      ).catch((error) => {
        logBotError("Background sync refresh failed.", { error: error.message });
      });
    }

    return;
  }

  await cache.syncManager.runCycle({ force: true, reason: "foreground" });
}

function triggerBackgroundSheetRefresh(cache, reason = "background") {
  const syncManager = cache?.syncManager;

  if (!syncManager) {
    return false;
  }

  const status = syncManager.getStatus?.() ?? { cycleInProgress: false };

  if (status.cycleInProgress) {
    return false;
  }

  runWithBackgroundPriority(() =>
    syncManager.runCycle({ force: false, reason })
  ).catch((error) => {
    console.error("Background sync refresh failed:", error);
  });
  return true;
}

async function applyAttendanceOptionChange(sheets, config, cache, nextOptions) {
  return withSheetOperation(async () => {
    await setAttendanceOptions(nextOptions);
    config.attendanceOptions = nextOptions;
    // syncRosterState → syncOnboardingRoster already handles prev/current/next months.
    // ensureNextMonthSheetExists is intentionally omitted — it would duplicate the sync.
    try {
      await syncRosterState(sheets, config);
      await refreshAdminCache(cache, config);
      await preloadSheetSnapshots(sheets, config, cache, { force: true });
      return { ok: true, syncPending: false };
    } catch (error) {
      cache.sheetSnapshots = null;
      cache.summaryMemoVersion = null;
      await refreshAdminCache(cache, config).catch(() => {});
      logBotWarn("Attendance options were saved locally but Sheet sync is pending.", {
        error: error.message
      });
      return { ok: true, syncPending: true };
    }
  });
}

async function addManagedAppointment(sheets, config, cache, appointment) {
  return withSheetOperation(async () => {
    const registryResult = await addAppointmentToRegistry(appointment);

    if (!registryResult.ok) {
      return registryResult;
    }

    try {
      const sheetAppointments = await addAppointmentToSheets(
        sheets,
        config,
        registryResult.appointment
      );
      const registry = await syncAppointmentRegistry(sheetAppointments);
      await syncOnboardingCodeColumn(
        sheets,
        config,
        registry.appointments.filter((entry) => entry.active)
      );
      await refreshAdminCache(cache, config);
      await preloadSheetSnapshots(sheets, config, cache, { force: true });
      return { ...registryResult, syncPending: false };
    } catch (error) {
      cache.sheetSnapshots = null;
      cache.summaryMemoVersion = null;
      await refreshAdminCache(cache, config).catch(() => {});
      logBotWarn("Appointment was added locally but Sheet sync is pending.", {
        appointment: registryResult.appointment,
        error: error.message
      });
      return { ...registryResult, syncPending: true };
    }
  });
}

async function removeManagedAppointment(sheets, config, cache, appointment, options = {}) {
  return withSheetOperation(async () => {
    const registryResult = await removeAppointmentFromRegistry(appointment, options);

    if (!registryResult.ok) {
      return registryResult;
    }

    try {
      const sheetAppointments = await removeAppointmentFromSheets(
        sheets,
        config,
        registryResult.appointment
      );
      const registry = await syncAppointmentRegistry(sheetAppointments);
      await syncOnboardingCodeColumn(
        sheets,
        config,
        registry.appointments.filter((entry) => entry.active)
      );
      await refreshAdminCache(cache, config);
      await preloadSheetSnapshots(sheets, config, cache, { force: true });
      return { ...registryResult, syncPending: false };
    } catch (error) {
      cache.sheetSnapshots = null;
      cache.summaryMemoVersion = null;
      await refreshAdminCache(cache, config).catch(() => {});
      logBotWarn("Appointment removal was saved locally but Sheet sync is pending.", {
        appointment: registryResult.appointment,
        error: error.message
      });
      return { ...registryResult, syncPending: true };
    }
  });
}

function sortAttendanceOptionsByGroupAndUsage(attendanceOptions, attendanceGroups = [], usageMap = {}) {
  const groupRank = new Map();
  const optionRank = new Map();

  attendanceGroups.forEach((group, groupIndex) => {
    group.options.forEach((option, optionIndex) => {
      groupRank.set(option, groupIndex);
      optionRank.set(option, optionIndex);
    });
  });

  return [...attendanceOptions].sort((left, right) => {
    const leftGroup = groupRank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightGroup = groupRank.get(right) ?? Number.MAX_SAFE_INTEGER;

    if (leftGroup !== rightGroup) {
      return leftGroup - rightGroup;
    }

    const leftUsage = Number(usageMap[left] ?? 0);
    const rightUsage = Number(usageMap[right] ?? 0);

    if (rightUsage !== leftUsage) {
      return rightUsage - leftUsage;
    }

    const leftOption = optionRank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOption = optionRank.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftOption !== rightOption) {
      return leftOption - rightOption;
    }

    return left.localeCompare(right);
  });
}

async function refreshAttendanceOptionUsage(sheets, config, cache) {
  const usageMap = await summarizeAttendanceOptionUsage(sheets, config);
  const sortedOptions = sortAttendanceOptionsByGroupAndUsage(
    config.attendanceOptions,
    config.attendanceGroups ?? [],
    usageMap
  );

  await setAttendanceOptionUsage(usageMap);
  await setAttendanceOptions(sortedOptions);
  config.attendanceOptions = sortedOptions;

  return sortedOptions;
}

async function renderCodesSubmenu(ctx, cache) {
  const pending = cache.pending;

  if (pending.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "All active personnel have onboarded.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "admin:main"),
          Markup.button.callback("❌ Close", "admin:close")
        ]
      ])
    );
    return;
  }

  const items = pending.map((entry) => ({
    label: entry.appointment,
    appointment: entry.appointment,
    expectedStateIdentity: getAppointmentStateIdentity(entry)
  }));
  const interaction = beginSelectionInteraction(ctx, "admin-code", items);

  await sendOrUpdateAdminMessage(
    ctx,
    buildInvitationAdminDescription(pending.length),
    buildPagedSelectionMenu(
      items,
      0,
      "admin:pick:code",
      "admin:menu:codes",
      "admin:main",
      { itemTokenBuilder: (_item, index) => `${interaction.id}:${index}` }
    )
  );
}

async function renderCodesSubmenuPage(ctx, cache, page) {
  const pending = cache.pending;

  if (pending.length === 0) {
    await renderCodesSubmenu(ctx);
    return;
  }

  const items = pending.map((entry) => ({
    label: entry.appointment,
    appointment: entry.appointment,
    expectedStateIdentity: getAppointmentStateIdentity(entry)
  }));
  const interaction = beginSelectionInteraction(ctx, "admin-code", items);

  await sendOrUpdateAdminMessage(
    ctx,
    buildInvitationAdminDescription(pending.length),
    buildPagedSelectionMenu(
      items,
      page,
      "admin:pick:code",
      "admin:menu:codes",
      "admin:main",
      { itemTokenBuilder: (_item, index) => `${interaction.id}:${index}` }
    )
  );
}

async function renderAddAdminSubmenu(ctx, cache, page = 0) {
  const candidates = cache.addAdminCandidates;

  if (candidates.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "No eligible appointments are available to add as admins.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "admin:menu:admins"),
          Markup.button.callback("❌ Close", "admin:close")
        ]
      ])
    );
    return;
  }

  const interaction = beginSelectionInteraction(ctx, "admin-add-admin", candidates);
  await sendOrUpdateAdminMessage(
    ctx,
    "Select an appointment to grant admin access.",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:addadmin",
      "admin:menu:addadmin",
      "admin:menu:admins",
      { itemTokenBuilder: (_item, index) => `${interaction.id}:${index}` }
    )
  );
}

async function renderRemoveAdminSubmenu(ctx, cache, page = 0) {
  const candidates = cache.removeAdminCandidates;

  if (candidates.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "There are no custom admins to remove.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "admin:menu:admins"),
          Markup.button.callback("❌ Close", "admin:close")
        ]
      ])
    );
    return;
  }

  const interaction = beginSelectionInteraction(ctx, "admin-remove-admin", candidates);
  await sendOrUpdateAdminMessage(
    ctx,
    "Select a custom admin to remove.",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:removeadmin",
      "admin:menu:removeadmin",
      "admin:menu:admins",
      { itemTokenBuilder: (_item, index) => `${interaction.id}:${index}` }
    )
  );
}

async function renderInviteSubmenu(ctx, cache, page = 0) {
  const candidates = cache.inviteCandidates;

  if (candidates.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "There are no unregistered personnel to invite.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "admin:main"),
          Markup.button.callback("❌ Close", "admin:close")
        ]
      ])
    );
    return;
  }

  const interaction = beginSelectionInteraction(ctx, "admin-invite", candidates);
  await sendOrUpdateAdminMessage(
    ctx,
    buildInvitationAdminDescription(candidates.length),
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:invite",
      "admin:menu:invite",
      "admin:main",
      { itemTokenBuilder: (_item, index) => `${interaction.id}:${index}` }
    )
  );
}

async function renderDeregisterSubmenu(ctx, cache, page = 0) {
  const candidates = cache.deregisterCandidates;

  if (candidates.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "There are no registered users to deregister.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "admin:main"),
          Markup.button.callback("❌ Close", "admin:close")
        ]
      ])
    );
    return;
  }

  const interaction = beginSelectionInteraction(ctx, "admin-deregister", candidates);
  await sendOrUpdateAdminMessage(
    ctx,
    "Select a person to deregister. This removes their Telegram binding and rotates their registration code.",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:deregister",
      "admin:menu:deregister",
      "admin:main",
      { itemTokenBuilder: (_item, index) => `${interaction.id}:${index}` }
    )
  );
}

async function renderRemoveAppointmentSubmenu(ctx, cache, page = 0) {
  const candidates = cache.removeAppointmentCandidates;

  if (candidates.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "There are no active appointments to remove.",
      buildAppointmentManagementBackMenu()
    );
    return;
  }

  const interaction = beginSelectionInteraction(ctx, "admin-remove-appointment", candidates);
  await sendOrUpdateAdminMessage(
    ctx,
    "Select an appointment to remove from the active roster.",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:appointmentremove",
      "admin:menu:appointments:remove",
      "admin:menu:roster",
      { itemTokenBuilder: (_item, index) => `${interaction.id}:${index}` }
    )
  );
}

async function renderTransferFromSubmenu(ctx, cache, page = 0) {
  const candidates = cache.transferFromCandidates;

  if (candidates.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "There are no registered users to transfer.",
      Markup.inlineKeyboard([[
        Markup.button.callback("🔙 Back", "admin:menu:roster"),
        Markup.button.callback("❌ Close", "admin:close")
      ]])
    );
    return;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    "Step 1/2 — Select the person to transfer (current appointment).",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:transferfrom",
      "admin:menu:transfer",
      "admin:menu:roster",
      {
        itemTokenBuilder: (item, index) =>
          fingerprintedSelectionToken(item, index, "bindingIdentity")
      }
    )
  );
}

async function renderTransferToSubmenu(ctx, cache, fromIdx, fromFingerprint, page = 0) {
  const from = resolveFingerprintedSelection(
    cache.transferFromCandidates,
    fromIdx,
    fromFingerprint,
    "bindingIdentity"
  );
  const candidates = cache.transferToCandidates;

  if (!from) {
    await renderTransferFromSubmenu(ctx, cache, 0);
    return;
  }

  if (candidates.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "There are no unbound appointment slots to transfer into.",
      Markup.inlineKeyboard([[
        Markup.button.callback("🔙 Back", "admin:menu:transfer:0"),
        Markup.button.callback("❌ Close", "admin:close")
      ]])
    );
    return;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    `Step 2/2 — Moving <b>${from.appointment}</b>.\nSelect the destination appointment slot.`,
    buildPagedSelectionMenu(
      candidates,
      page,
      `admin:pick:transferto:${fromIdx}:${fromFingerprint}`,
      `admin:menu:transferto:${fromIdx}:${fromFingerprint}`,
      "admin:menu:transfer:0",
      { itemTokenBuilder: fingerprintedSelectionToken }
    ),
    { parse_mode: "HTML" }
  );
}

function isAttendanceTransferBlocked(results) {
  return results.some(
    (entry) =>
      entry.conflict ||
      entry.skipped ||
      !entry.transferred
  );
}

function isAttendanceTransferCleanupBlocked(results) {
  return results.length === 0 || results.some(
    (entry) => entry.conflict || entry.skipped || !entry.transferred
  );
}

function formatAttendanceTransferBlockedMessage(results, toAppointment) {
  const conflicts = results.filter(
    (entry) => entry.reason === "destination_has_attendance"
  );
  const structuralFailures = results.filter((entry) =>
    [
      "empty_sheet",
      "from_row_not_found",
      "to_row_not_found",
      "duplicate_appointment_row",
      "no_date_columns"
    ].includes(entry.reason)
  );
  const lines = [
    "Transfer stopped safely. No binding or attendance was changed."
  ];

  for (const entry of conflicts) {
    const dates = entry.conflictingDates?.length > 0
      ? ` on ${entry.conflictingDates.join(", ")}`
      : "";
    lines.push(
      `${entry.title}: ${toAppointment} already has different attendance${dates}.`
    );
  }

  const structuralReasonMessages = {
    empty_sheet: "the monthly sheet is empty",
    from_row_not_found: "the source appointment row is missing",
    to_row_not_found: "the destination appointment row is missing",
    duplicate_appointment_row: "the appointment appears more than once",
    no_date_columns: "the monthly sheet has no attendance date columns"
  };

  for (const entry of structuralFailures) {
    lines.push(`${entry.title}: ${structuralReasonMessages[entry.reason]}.`);
  }

  lines.push(
    "All managed months are transferred together, so the other months were left unchanged."
  );

  if (conflicts.length > 0) {
    lines.push("Review the destination cells in Google Sheets, then retry the transfer.");
  } else {
    lines.push("Run Sync Roster to repair the monthly rows, then retry the transfer.");
  }

  return lines.join("\n");
}

function formatAppointmentTransferFailure(result, toAppointment) {
  const messages = {
    from_not_found: "The source appointment is no longer active.",
    from_not_bound: "The source appointment is no longer bound to a user.",
    from_binding_changed:
      "The source binding changed after this transfer menu was opened.",
    to_not_found: "The destination appointment is no longer active.",
    to_already_bound:
      `${toAppointment} is already bound to a user and cannot be used as the destination.`,
    attendance_transfer_recovery_required:
      "Another attendance transfer requires recovery before a new transfer can begin."
  };

  return [
    "Transfer menu expired. No binding or attendance was changed.",
    messages[result.reason] || "The selected appointments are no longer available for transfer.",
    "Reopen Transfer and choose from the current list."
  ].join("\n");
}

async function renderAttendanceOptionsMenu(ctx, config) {
  await sendOrUpdateAdminMessage(
    ctx,
    buildAttendanceOptionsDescription(
      config.attendanceOptions,
      config.onboardingAttendanceOptions,
      config.attendanceGroups
    ),
    buildAttendanceOptionsMenu(),
    { parse_mode: "HTML" }
  );
}

async function renderAttendanceOptionRemovalMenu(ctx, config, page = 0) {
  const items = config.attendanceOptions.map((option) => ({ label: option, option }));

  if (items.length === 0) {
    await renderAttendanceOptionsMenu(ctx, config);
    return;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    "Select an attendance option to remove.",
    buildPagedSelectionMenu(
      items,
      page,
      "admin:pick:optionremove",
      "admin:options:remove",
      "admin:menu:options",
      {
        itemTokenBuilder: (item, index) =>
          fingerprintedSelectionToken(item, index, "option")
      }
    )
  );
}

async function runAdminAction(action, ctx, bot, sheets, config, cache) {
  if (!(await requireAdmin(ctx, config))) {
    return;
  }

  if (action === "pending") {
    await ensureSheetReadiness(sheets, config, cache);
    const pending = cache.pending;
    await sendOrUpdateAdminMessage(
      ctx,
      pending.length === 0
        ? "All active personnel have onboarded."
        : pending.map((entry) => `${entry.appointment} - ${entry.secretCode}`).join("\n"),
      buildAdminRosterMenu()
    );
    return;
  }

  if (action === "admins") {
    const admins = cache.admins;
    await sendOrUpdateAdminMessage(
      ctx,
      admins.map((entry) => `${entry.appointment} (${entry.source})`).join("\n"),
      buildAdminManageMenu()
    );
    return;
  }

  if (action === "codes") {
    await ensureSheetReadiness(sheets, config, cache);
    await renderCodesSubmenu(ctx, cache);
    return;
  }

  if (action === "syncroster") {
    // Do NOT await — roster sync can take several minutes with a large roster.
    // Telegraf kills any action/command handler Promise at 90s; awaiting would
    // cause every sync to appear as a failure even when it ultimately succeeds.
    // The sync sends its own completion message via ctx when it finishes.
    runWithBackgroundPriority(() => handleSyncRosterAdminAction(ctx, config, {
      syncRosterState,
      refreshAdminCache,
      preloadSheetSnapshots,
      resetConflictedQueueEntries,
      sendOrUpdateAdminMessage,
      sendCompletionMessage: (_ctx, message, replyMarkup, extraOptions) =>
        sendBackgroundBotMessage(
          bot,
          ctx.chat.id,
          message,
          replyMarkup,
          extraOptions
        ),
      sheets,
      cache
    })).catch((error) => {
      logBotError("[Admin] Roster sync error (unhandled).", { error: error.message });
    });
    return;
  }

  if (action === "clearprotections") {
    const confirmation = beginInteraction(ctx, "clear-protections", { confirm: {} }, { ttlMs: 2 * 60 * 1000 });
    await sendOrUpdateAdminMessage(
      ctx,
      "Clear protections from every managed sheet? This can expose attendance cells to accidental edits.",
      Markup.inlineKeyboard([[
        Markup.button.callback("✅ Clear Protections", `admin:confirm:clearprotections:${confirmation.id}`),
        Markup.button.callback("↩️ Cancel", "admin:main")
      ]])
    );
    return;
  }

  if (action === "changespreadsheet") {
      beginTextInput(ctx, "spreadsheet", { ttlMs: 10 * 60 * 1000 });
    await sendOrUpdateAdminMessage(
      ctx,
      [
        "📄 Change Target Spreadsheet",
        "",
        `Current spreadsheet ID: <code>${escapeHtml(config.spreadsheetId)}</code>`,
        "",
        "Send the new Google Sheets spreadsheet ID. You can find it in the sheet URL between <code>/d/</code> and <code>/edit</code>.",
        "",
        "⚠️ This will immediately switch the bot to the new spreadsheet and update your <code>.env</code> file on disk. Make sure the service account has access to the new sheet before proceeding."
      ].join("\n"),
      Markup.inlineKeyboard([[
        Markup.button.callback("🔙 Back", "admin:menu:roster"),
        Markup.button.callback("❌ Cancel", "admin:changespreadsheet:cancel")
      ]]),
      { parse_mode: "HTML" }
    );
    return;
  }

  if (action === "changespreadsheet:cancel") {
    cancelInteractions(ctx);
    await sendOrUpdateAdminMessage(ctx, buildRosterDescription(), buildAdminRosterMenu());
    return;
  }

  if (action.startsWith("selfheallogs:")) {
    const page = Number(action.split(":")[1]) || 0;
    await sendOrUpdateAdminMessage(
      ctx,
      buildSelfHealLogsText(page, config.timezone),
      buildSelfHealLogsMenu(page)
    );
    return;
  }

  if (action === "flushqueue") {
    // Fire-and-forget: flush can take tens of seconds; Telegraf 90 s limit would kill it.
    runWithBackgroundPriority(() => handleFlushAttendanceAdminAction(ctx, config, {
      getAttendanceQueueStatus,
      flushAttendanceQueue,
      reconcilePendingAttendanceWithSheets,
      syncRosterState,
      refreshAdminCache,
      resetConflictedQueueEntries,
      preloadSheetSnapshots,
      sendOrUpdateAdminMessage,
      sendCompletionMessage: (_ctx, message, replyMarkup, extraOptions) =>
        sendBackgroundBotMessage(
          bot,
          ctx.chat.id,
          message,
          replyMarkup,
          extraOptions
        ),
      sheets,
      cache
    })).catch((error) => {
      logBotError("Background attendance flush error.", { error: error.message });
    });
    return;
  }

  if (action === "queue") {
    await handleQueueStatusAdminAction(ctx, {
      getAttendanceQueueStatus,
      listPendingAttendanceEvents,
      sendOrUpdateAdminMessage,
      buildAdminMenu
    });
    return;
  }

  if (action === "promptall") {
    const confirmation = beginInteraction(ctx, "prompt-all", { confirm: {} }, { ttlMs: 2 * 60 * 1000 });
    await sendOrUpdateAdminMessage(
      ctx,
      "Send an attendance prompt to every currently bound user?",
      Markup.inlineKeyboard([[
        Markup.button.callback("✅ Prompt All", `admin:confirm:promptall:${confirmation.id}`),
        Markup.button.callback("↩️ Cancel", "admin:main")
      ]])
    );
    return;
  }

  if (action === "promptall:execute") {
    const users = (await listUsers()).filter((user) => user.appointment);

    if (users.length === 0) {
      await sendOrUpdateAdminMessage(
        ctx,
        "No bound users found yet.",
        Markup.inlineKeyboard([[
          Markup.button.callback("🔙 Back", "admin:main"),
          Markup.button.callback("❌ Close", "admin:close")
        ]])
      );
      return;
    }

      const initiatingChatId = ctx.chat.id;
      const queuedPromptJob = enqueueAttendancePromptBroadcast(() =>
      runWithBackgroundPriority(async () => {
        const currentUsers = (await listUsers()).filter((user) => user.appointment);
        const broadcastStartedAt = Date.now();
        const broadcastStartedAtIso = new Date(broadcastStartedAt).toISOString();
        const broadcastContext = buildAttendancePromptBroadcastContext(config);
        // Warm-cache refreshes are nonessential for Prompt All and will defer
        // while this broadcast is active. Local queue/cache data remains usable.
        await ensureSheetReadiness(sheets, config, cache);
        const promptResults = await allSettledConcurrent(
          currentUsers.map((user) => (signal) =>
            buildAndSendAttendancePrompt(
              bot,
              config,
              user,
              cache,
              broadcastContext,
              signal
            )
          ),
          TELEGRAM_SEND_CONCURRENCY
        );
        const sent = promptResults.filter((result) => result.status === "fulfilled").length;
        logAttendancePromptBroadcast("manual", broadcastStartedAt, promptResults);

        const promptedAt = new Date().toISOString();
        const patches = [];
        for (let index = 0; index < promptResults.length; index += 1) {
          if (promptResults[index].status === "fulfilled") {
            const result = promptResults[index].value;
            patches.push({
              chatId: result.chatId,
              expectedAppointment: currentUsers[index].appointment,
              notSubmittedAfter: broadcastStartedAtIso,
              notPromptedAfter: broadcastStartedAtIso,
              patch: {
                awaitingAttendance: result.awaitingAttendance,
                attendancePromptMessageIds: result.attendancePromptMessageIds,
                promptedAt
              }
            });
          } else {
            logBotError("Failed to send prompt.", {
              recipientIndex: index,
              error: promptResults[index].reason?.message
            });
          }
        }

        await batchUpdateUsersByChatId(patches);
        await sendBackgroundBotMessage(
          bot,
          initiatingChatId,
          `Attendance prompt delivery complete: ${sent}/${currentUsers.length} sent.`,
          Markup.inlineKeyboard([[
            Markup.button.callback("🔙 Back", "admin:main"),
            Markup.button.callback("❌ Close", "admin:close")
          ]])
        );
      })
    );

    await sendOrUpdateAdminMessage(
      ctx,
      `${queuedPromptJob.wasQueued ? "Queued" : "Sending"} attendance prompts to ${users.length} bound user(s) in the background. You can continue using the bot.`,
      Markup.inlineKeyboard([[
        Markup.button.callback("🔙 Back", "admin:main"),
        Markup.button.callback("❌ Close", "admin:close")
      ]])
    );

    void queuedPromptJob.completion.catch((error) => {
      logBotError("Background Prompt All failed.", { error: error.message });
    });
    return;
  }

  if (action === "summary") {
    const targetDate = new Date();
    await ensureSheetReadiness(sheets, config, cache);
    await renderCachedSummaryOrWarmup(ctx, cache, config, targetDate);
    return;
  }

  if (action.startsWith("summary:")) {
    if (action.startsWith("summary:unaccounted:")) {
      const targetDate = parseIsoDate(action.split(":")[2]);

      if (!targetDate) {
        await sendOrUpdateAdminMessage(ctx, "Invalid summary date.", buildAdminRosterMenu());
        return;
      }

      if (!(await isReminderWorkingDay(targetDate, config.timezone))) {
        await renderCachedSummaryOrWarmup(ctx, cache, config, targetDate);
        return;
      }

      const registry = await getAppointmentRegistry();
      const unaccountedAppointments = getUnaccountedAppointments(cache, config, targetDate);
      const boundRows = [];
      const unbound = [];

      for (const appointment of unaccountedAppointments) {
        const entry = registry.appointments.find(
          (value) => value.appointment.toUpperCase() === appointment.toUpperCase()
        );
        const url = buildChatUrlForRegistryEntry(entry);

        if (url) {
          boundRows.push([{
            text: appointment,
            url
          }]);
        } else {
          unbound.push(appointment);
        }
      }

      const lines = [
        `Unaccounted for ${formatAttendanceDateLabel(targetDate, config.timezone)}:`
      ];

      if (unaccountedAppointments.length === 0) {
        lines.push("No personnel are currently unaccounted.");
      } else {
        lines.push(...unaccountedAppointments.map((appointment) => `• ${appointment}`));
      }

      if (unbound.length > 0) {
        lines.push("");
        lines.push("No Telegram chat available for:");
        lines.push(...unbound.map((appointment) => `• ${appointment}`));
      }

      await sendOrUpdateAdminMessage(
        ctx,
        lines.join("\n"),
        buildUnaccountedMenu(targetDate, config.timezone, boundRows, "admin:menu:roster", "admin")
      );
      return;
    }

    const targetDate = parseIsoDate(action.split(":")[1]);

    if (!targetDate) {
      await sendOrUpdateAdminMessage(ctx, "Invalid summary date.", buildAdminRosterMenu());
      return;
    }

    await ensureSheetReadiness(sheets, config, cache);
    await renderCachedSummaryOrWarmup(ctx, cache, config, targetDate);
    return;
  }
}

// Sends the attendance prompt message to a pre-fetched user object and returns
// the state patch to apply. Caller is responsible for writing the patch to disk
// so that bulk sends can batch all writes into a single storage operation.
function buildAttendancePromptBroadcastContext(config, date = new Date()) {
  const dateLabel = formatAttendanceDateLabel(date, config.timezone);
  const promptId = newAttendancePromptId();

  return {
    date,
    dateLabel,
    promptId,
    emptyStatusMessage:
      `You have not updated your attendance for ${dateLabel}. ` +
      `Select your attendance for ${dateLabel}.`,
    replyMarkup: buildDatedAttendanceMenu(
      config,
      date,
      0,
      "home:pick:attendance",
      "home:attendance:page",
      "home:main",
      [],
      { promptId }
    )
  };
}

function logAttendancePromptBroadcast(source, startedAt, results) {
  const latencies = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => Number(result.value?.sendLatencyMs))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const percentile = (ratio) => {
    if (latencies.length === 0) {
      return null;
    }

    return latencies[Math.min(
      latencies.length - 1,
      Math.ceil(latencies.length * ratio) - 1
    )];
  };

  logBot("Attendance prompt broadcast completed.", {
    source,
    recipients: results.length,
    sent: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
    durationMs: Date.now() - startedAt,
    sendLatencyP50Ms: percentile(0.5),
    sendLatencyP95Ms: percentile(0.95)
  });
}

async function buildAndSendAttendancePrompt(
  bot,
  config,
  user,
  cache,
  broadcastContext = null,
  signal = null
) {
  const context = broadcastContext ?? buildAttendancePromptBroadcastContext(config);
  const today = context.date;
  const dateLabel = context.dateLabel;
  const currentStatus = user?.appointment && cache
    ? getCachedAttendanceStatus(cache, config, user.appointment, today)
    : "";
  const promptMessage = currentStatus
    ? `Your attendance for ${dateLabel} is currently ${currentStatus}. Update it if needed.`
    : context.emptyStatusMessage;
  const sendStartedAt = Date.now();
  const sentMessage = signal && typeof bot.telegram.callApi === "function"
    ? await bot.telegram.callApi(
      "sendMessage",
      {
        chat_id: user.chatId,
        text: promptMessage,
        ...context.replyMarkup
      },
      { signal }
    )
    : await bot.telegram.sendMessage(
      user.chatId,
      promptMessage,
      context.replyMarkup
    );
  return {
    chatId: user.chatId,
    awaitingAttendance: !currentStatus,
    attendancePromptMessageIds: appendAttendancePromptMessageId(
      user,
      getMessageId(sentMessage)
    ),
    sendLatencyMs: Date.now() - sendStartedAt
  };
}

async function sendPromptToChat(bot, config, chatId, cache = null) {
  const user = await getUserByChatId(chatId);
  const {
    awaitingAttendance,
    attendancePromptMessageIds
  } = await buildAndSendAttendancePrompt(bot, config, user, cache);
  // Only set awaitingAttendance if no status is on file; users who already filed
  // should not be put into a text-prompt state just from receiving the reminder.
  await updateUserByChatId(chatId, {
    awaitingAttendance,
    attendancePromptMessageIds,
    promptedAt: new Date().toISOString()
  });
}

function hasUnfilledAttendance(cache, config, appointment, date = new Date()) {
  if (!appointment) {
    return false;
  }

  return !getCachedAttendanceStatus(cache, config, appointment, date);
}

async function ensureUserBound(ctx, config) {
  const user = await getUserByChatId(ctx.chat.id);

  if (
    user?.appointment &&
    ctx.from?.id &&
    String(user.userId) === String(ctx.from.id)
  ) {
    return user;
  }

  await askForSecretCode(ctx, config);
  return null;
}

async function handleOnboardCommand(ctx, config, deps) {
  await deps.registerUser(ctx);
  await deps.ensureSheetReadiness(deps.sheets, config, deps.adminCache);
  await deps.resetConversationState(ctx);
  await ctx.reply(
    [
      "This bot writes your attendance into the shared monthly Google Sheet.",
      "To bind your Telegram account securely, enter the secret code assigned to your appointment."
    ].join("\n")
  );
  await deps.askForSecretCode(ctx, config);
}

async function handleInviteCommand(ctx, bot, config, deps) {
  if (!(await deps.requireAdmin(ctx, config))) {
    return;
  }

  await deps.ensureSheetReadiness(deps.sheets, config, deps.adminCache);
  const appointment = getCommandArgument(ctx.message.text, "invite");

  if (!appointment) {
    await deps.renderInviteSubmenu(ctx, deps.adminCache, 0);
    return;
  }

  const invite = await deps.getOnboardingInvite(appointment);

  if (!invite.ok) {
    await ctx.reply("Appointment not found in the active onboarding roster.");
    return;
  }

  await ctx.reply(
    deps.buildInviteMessage(invite, bot, { html: true }),
    {
      ...deps.buildInviteReplyMarkup(invite, bot),
      parse_mode: "HTML"
    }
  );
}

function createUiOperationTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.name = "UiOperationTimeoutError";
  error.code = "ETIMEDOUT";
  error.timeoutMs = timeoutMs;
  return error;
}

async function withUiOperationTimeout(label, operation, timeoutMs = 8000) {
  let timeoutId = null;

  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createUiOperationTimeoutError(label, timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

// Guards against concurrent roster syncs. withUiOperationTimeout(Promise.race)
// was previously used here but it does not cancel in-flight Sheets API calls —
// it only abandons the awaiter, leaving the calls running and jamming the
// semaphore queue. Each "failed" attempt would queue more API calls behind the
// still-running ones, making subsequent attempts progressively slower.
let rosterSyncInProgress = false;

// ─── Self-healing ─────────────────────────────────────────────────────────────

// Minimum gap between autonomous healing runs (prevents cascading repairs).
let lastSelfHealAt = 0;
const SELF_HEAL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Returns the sheet title (e.g. "Apr 26") for the given date in the bot's
 * configured timezone, using the same format as googleSheets.js / getMonthParts.
 */
function getSheetMonthTitle(date, timezone) {
  const month = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short" }).format(date);
  const year = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "2-digit" }).format(date);
  return `${month} ${year}`;
}

/**
 * Returns a Set of the two month-sheet titles that self-healing inspects and
 * may structurally repair: current month and next month only.
 * Previous months are never examined or written to — an appointment may
 * legitimately be absent from an older sheet if it was added after that month.
 */
function getHealableMonthTitles(timezone) {
  const now = new Date();
  const numericMonth = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "numeric" }).format(now)
  ) - 1; // 0-indexed
  const numericYear = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(now)
  );

  return new Set([
    getSheetMonthTitle(new Date(Date.UTC(numericYear, numericMonth, 1)), timezone),
    getSheetMonthTitle(new Date(Date.UTC(numericYear, numericMonth + 1, 1)), timezone)
  ]);
}

/**
 * Returns true if the given appointment has at least one non-blank attendance
 * value in the snapshot (i.e. the row was actually used).
 */
function snapshotAppointmentHasData(snapshot, appointmentName) {
  const index = (snapshot.appointments ?? []).indexOf(appointmentName);

  if (index === -1) {
    return false;
  }

  for (const values of (snapshot.statusesByDay ?? new Map()).values()) {
    if (String(values[index] ?? "").trim()) {
      return true;
    }
  }

  return false;
}

/**
 * Compares each month-sheet snapshot against the active registry appointments
 * and returns per-sheet divergence objects.
 *
 * Returns an array of:
 *   { sheetTitle, missingFromSheet, unexpectedInSheet, unexpectedWithData }
 */
function detectSnapshotDivergences(snapshotBundle, activeRegistryAppointments) {
  if (!snapshotBundle?.snapshots?.size) {
    return [];
  }

  const registryNormalized = new Set(
    activeRegistryAppointments.map((a) => a.toUpperCase().trim())
  );
  const divergences = [];

  for (const [title, snapshot] of snapshotBundle.snapshots) {
    const sheetAppointments = snapshot.appointments ?? [];
    const sheetNormalized = new Set(sheetAppointments.map((a) => a.toUpperCase().trim()));

    const missingFromSheet = activeRegistryAppointments.filter(
      (a) => !sheetNormalized.has(a.toUpperCase().trim())
    );
    const unexpectedInSheet = sheetAppointments.filter(
      (a) => !registryNormalized.has(a.toUpperCase().trim())
    );
    const unexpectedWithData = unexpectedInSheet.filter(
      (apt) => snapshotAppointmentHasData(snapshot, apt)
    );

    if (missingFromSheet.length > 0 || unexpectedInSheet.length > 0) {
      divergences.push({
        sheetTitle: title,
        missingFromSheet,
        unexpectedInSheet,
        unexpectedWithData
      });
    }
  }

  return divergences;
}

/**
 * In-memory ring-buffer of self-healing cycle results, newest first.
 * Each entry: { runAt, divergences, addResults, syncFailed }
 * Capped at SELF_HEAL_LOG_MAX entries so memory usage stays bounded.
 */
const selfHealLog = [];
const SELF_HEAL_LOG_MAX = 30;

const SELF_HEAL_LOGS_PER_PAGE = 5;

/**
 * Renders one page of the self-healing log as plain text (HTML parse mode).
 */
function buildSelfHealLogsText(page, timezone) {
  if (selfHealLog.length === 0) {
    return [
      "<b>🔧 Self-Heal Logs</b>",
      "",
      "No self-healing cycles have run yet.",
      "",
      "The bot checks for sheet divergences every 5 minutes and logs any repairs here."
    ].join("\n");
  }

  const totalPages = Math.ceil(selfHealLog.length / SELF_HEAL_LOGS_PER_PAGE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const entries = selfHealLog.slice(
    safePage * SELF_HEAL_LOGS_PER_PAGE,
    (safePage + 1) * SELF_HEAL_LOGS_PER_PAGE
  );

  const lines = [
    `<b>🔧 Self-Heal Logs</b>  (page ${safePage + 1}/${totalPages})`,
    ""
  ];

  for (const entry of entries) {
    const runDate = new Date(entry.runAt);
    const dateLabel = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "2-digit",
      month: "short",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(runDate).replace(",", "");

    lines.push(`<b>🕐 ${dateLabel}</b>`);

    if (entry.syncFailed) {
      lines.push("  ❌ Structural sync failed after healing.");
    }

    for (const div of entry.divergences) {
      lines.push(`  <b>${div.sheetTitle}</b>`);

      for (const apt of div.missingFromSheet) {
        lines.push(`    • Restored: ${apt}`);
      }

      for (const apt of div.unexpectedWithData) {
        const res = (entry.addResults ?? []).find((r) => r.appointment === apt);
        const tag = res?.ok ? "added to roster" : `add failed (${res?.reason ?? "?"})`;
        lines.push(`    • Unknown+data: ${apt} → ${tag}`);
      }

      const noData = div.unexpectedInSheet.filter((a) => !div.unexpectedWithData.includes(a));

      for (const apt of noData) {
        lines.push(`    • Removed (no data): ${apt}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Returns the inline keyboard for the self-heal logs view (pagination + back).
 */
function buildSelfHealLogsMenu(page) {
  const totalPages = Math.ceil(selfHealLog.length / SELF_HEAL_LOGS_PER_PAGE);
  const navRow = [];

  if (page > 0) {
    navRow.push(Markup.button.callback("◀ Newer", `admin:selfheallogs:${page - 1}`));
  }

  if (page < totalPages - 1) {
    navRow.push(Markup.button.callback("Older ▶", `admin:selfheallogs:${page + 1}`));
  }

  const rows = [];

  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([
    Markup.button.callback("🔙 Back", "admin:menu:roster"),
    Markup.button.callback("❌ Close", "admin:close")
  ]);

  return Markup.inlineKeyboard(rows);
}

/**
 * Detects appointment divergences between the cached month-sheet snapshots and
 * the active registry, then heals the sheets and notifies all admins.
 *
 * Throttled by SELF_HEAL_COOLDOWN_MS so it cannot fire more than once per hour.
 * Skips when a roster sync is already in progress.
 */
async function runSelfHealingCycle(sheets, config, adminCache) {
  const now = Date.now();

  if (now - lastSelfHealAt < SELF_HEAL_COOLDOWN_MS) {
    return;
  }

  if (rosterSyncInProgress) {
    return;
  }

  const snapshotBundle = adminCache.sheetSnapshots;

  if (!snapshotBundle?.snapshots?.size) {
    return;
  }

  const registry = await getAppointmentRegistry();
  const activeAppointments = registry.appointments
    .filter((entry) => entry.active)
    .map((entry) => entry.appointment);

  if (activeAppointments.length === 0) {
    return;
  }

  // Only inspect and repair current month and next month — never previous months.
  // ONBOARDING is always kept in sync by syncRosterState regardless.
  const healableTitles = getHealableMonthTitles(config.timezone);
  const filteredSnapshots = new Map(
    [...snapshotBundle.snapshots].filter(([title]) => healableTitles.has(title))
  );

  if (filteredSnapshots.size === 0) {
    return;
  }

  const filteredBundle = { ...snapshotBundle, snapshots: filteredSnapshots };
  const divergences = detectSnapshotDivergences(filteredBundle, activeAppointments);

  if (divergences.length === 0) {
    return;
  }

  // Commit the timestamp immediately — even if healing partially fails we don't
  // want the next 5-minute cycle to re-trigger before the cooldown expires.
  lastSelfHealAt = now;
  logBot("[SelfHeal] Divergences detected — beginning healing cycle.", {
    sheets: divergences.map((d) => d.sheetTitle)
  });

  // Step 1: Add unexpected-with-data appointments to the roster BEFORE the
  // structural sync so their rows are preserved rather than discarded.
  const toAdd = [
    ...new Set(divergences.flatMap((d) => d.unexpectedWithData))
  ];
  const addResults = [];

  for (const apt of toAdd) {
    try {
      const result = await addManagedAppointment(sheets, config, adminCache, apt);
      addResults.push({ appointment: apt, ok: result.ok, reason: result.reason });
      logBot(`[SelfHeal] addManagedAppointment: ${apt}`, { ok: result.ok });
    } catch (error) {
      addResults.push({ appointment: apt, ok: false, reason: error.message });
      logBotError(`[SelfHeal] Failed to add appointment: ${apt}`, { error: error.message });
    }
  }

  // Step 2: Structural sync — repairs ONBOARDING, current month, and next month.
  let syncFailed = false;
  rosterSyncInProgress = true;

  try {
    await syncRosterState(sheets, config);
    await refreshAdminCache(adminCache, config);
    await preloadSheetSnapshots(sheets, config, adminCache, {
      force: true,
      structural: false,
      normalizeAliases: true
    });
    logBot("[SelfHeal] Structural sync complete.");
  } catch (error) {
    syncFailed = true;
    logBotError("[SelfHeal] Structural sync failed.", { error: error.message });
  } finally {
    rosterSyncInProgress = false;
  }

  // Step 3: Store results in the in-memory log (viewable from Admin → Roster → Self-Heal Logs).
  selfHealLog.unshift({
    runAt: new Date().toISOString(),
    divergences,
    addResults,
    syncFailed
  });

  if (selfHealLog.length > SELF_HEAL_LOG_MAX) {
    selfHealLog.length = SELF_HEAL_LOG_MAX;
  }

  logBot("[SelfHeal] Cycle complete.", {
    divergentSheets: divergences.length,
    appointmentsAdded: addResults.filter((r) => r.ok).length,
    syncFailed
  });
}

async function handleSyncRosterAdminAction(ctx, config, deps) {
  const adminBackMenu = Markup.inlineKeyboard([[
    Markup.button.callback("🔙 Back", "admin:main"),
    Markup.button.callback("❌ Close", "admin:close")
  ]]);
  const sendCompletionMessage = deps.sendCompletionMessage ?? deps.sendOrUpdateAdminMessage;

  if (rosterSyncInProgress) {
    await deps.sendOrUpdateAdminMessage(
      ctx,
      "A roster sync is already in progress. Please wait for the current sync to complete.",
      adminBackMenu
    );
    return;
  }

  // Set the guard BEFORE the first await so that any concurrent call starting
  // in the same microtask turn will see it and be rejected.
  rosterSyncInProgress = true;

  try {
    logBot("[Admin] Roster sync started.");
    await deps.sendOrUpdateAdminMessage(
      ctx,
      "Syncing roster with Google Sheets. This may take a minute with a large roster — please wait."
    );

    // syncRosterState → syncOnboardingRoster runs all 4 sync steps:
    //   1. Sort ONBOARDING column A to canonical order
    //   2–3. Sort + add new users in current and next month sheets
    //   4. Check sheet formatting (prev month layout-only)
    // ensureNextMonthSheetExists is intentionally NOT called here — it would
    // trigger a second full syncOnboardingRoster run (all 4 steps again).
    const roster = await deps.syncRosterState(deps.sheets, config);

    if (roster.driftDetected) {
      logBot("[Admin] Roster sync: drift detected in ONBOARDING sheet — halted.");
      await sendCompletionMessage(
        ctx,
        "⚠️ Roster sync halted: the ONBOARDING sheet has structural issues (blank rows, duplicate appointments, or an inline STOP marker). Please fix the ONBOARDING sheet and run Sync Roster again.",
        adminBackMenu
      );
      return;
    }

    await deps.refreshAdminCache(deps.cache, config);

    // Reload snapshots from the sheets that syncRosterState already repaired.
    // structural:false because ensureMonthlyAttendanceSheet was already run by
    // syncOnboardingRoster above — no need to pay for layout/formatting writes twice.
    await deps.preloadSheetSnapshots(deps.sheets, config, deps.cache, {
      force: true,
      structural: false,
      normalizeAliases: true
    });

    // After the layout fix, reset any attendance entries that were stuck in "conflicted"
    // state due to a layout mismatch. They will be retried on the next flush cycle.
    const resetResult = await deps.resetConflictedQueueEntries();

    if (resetResult.resetCount > 0) {
      logBot("Roster sync: conflicted queue entries re-queued for retry.", { resetCount: resetResult.resetCount });
    }

    logBot("[Admin] Roster sync complete.", {
      prevMonth: roster.prevMonthTitle,
      currentMonth: roster.currentMonthTitle,
      nextMonth: roster.nextMonthTitle
    });

    const summaryLines = [
      `✅ Roster synced from ${config.onboardingSheetTitle}.`,
      `Last month: ${roster.prevMonthTitle}`,
      `Current month: ${roster.currentMonthTitle}`,
      `Next month: ${roster.nextMonthTitle}`
    ];
    const integrity = roster.integrity;

    if (integrity?.checksum) {
      summaryLines.push(`Roster checksum: ${integrity.checksum.slice(0, 12)}`);
      const repairCount =
        (integrity.repairedUserBindings?.length ?? 0) +
        (integrity.repairedRegistryBindings?.length ?? 0) +
        (integrity.clearedUserBindings?.length ?? 0);

      if (repairCount > 0) {
        summaryLines.push(`Integrity repairs applied: ${repairCount}`);
      }
      if (!integrity.bindingsConsistent) {
        summaryLines.push(
          `⚠️ Binding conflicts need review: ${integrity.conflicts?.length ?? 0}`
        );
      }
    }

    if (resetResult.resetCount > 0) {
      summaryLines.push(`\n⚠️ ${resetResult.resetCount} previously stuck attendance ${resetResult.resetCount === 1 ? "entry" : "entries"} re-queued for retry.`);
    }

    await sendCompletionMessage(ctx, summaryLines.join("\n"), adminBackMenu);
  } catch (error) {
    logBotError("[Admin] Roster sync failed.", { error: error.message });
    await sendCompletionMessage(
      ctx,
      `❌ Roster sync failed: ${error.message}\n\nThe queued attendance was kept. The bot will retry its automatic repair path on a later sync.`,
      adminBackMenu
    );
    return;
  } finally {
    rosterSyncInProgress = false;
  }
}

async function handleClearProtectionsAdminAction(ctx, config, deps) {
  const adminBackMenu = Markup.inlineKeyboard([[
    Markup.button.callback("🔙 Back", "admin:main"),
    Markup.button.callback("❌ Close", "admin:close")
  ]]);
  const sendCompletionMessage = deps.sendCompletionMessage ?? deps.sendOrUpdateAdminMessage;
  logBot("[Admin] Clear all protections started.");
  await deps.sendOrUpdateAdminMessage(
    ctx,
    "Removing all sheet protections from the spreadsheet. Please wait…"
  );

  try {
    const { removedCount } = await deps.clearAllSheetProtections(deps.sheets, config.spreadsheetId);
    logBot("[Admin] Clear all protections complete.", { removedCount });
    await sendCompletionMessage(
      ctx,
      removedCount === 0
        ? "✅ No protections found — the spreadsheet is already unprotected."
        : `✅ Removed ${removedCount} protection${removedCount === 1 ? "" : "s"} from the spreadsheet.`,
      adminBackMenu
    );
  } catch (error) {
    logBotError("[Admin] Clear all protections failed.", { error: error.message });
    await sendCompletionMessage(
      ctx,
      `❌ Failed to clear protections: ${error.message}`,
      adminBackMenu
    );
    throw error;
  }
}

const ATTENDANCE_ROSTER_RECOVERY_REASONS = new Set([
  "appointment_missing",
  "appointment_identity_changed",
  "duplicate_appointment_row",
  "duplicate_date_column",
  "date_column_changed",
  "sheet_layout_changed",
  "empty_sheet",
  "from_row_not_found",
  "to_row_not_found",
  "no_date_columns"
]);

function isAttendanceRosterRecoveryReason(reason) {
  return ATTENDANCE_ROSTER_RECOVERY_REASONS.has(String(reason ?? ""));
}

async function selfHealAttendanceRosterForQueue(deps, config) {
  if (rosterSyncInProgress) {
    logBotWarn("[SelfHeal] Attendance push found a roster conflict, but a roster sync is already running.");
    return { ok: false, reason: "sync_in_progress", resetCount: 0 };
  }

  rosterSyncInProgress = true;
  logBot("[SelfHeal] Attendance push found a roster conflict; starting one automatic repair attempt.");

  try {
    const roster = await deps.syncRosterState(deps.sheets, config);

    if (roster.driftDetected) {
      logBotWarn("[SelfHeal] Automatic roster repair stopped on unresolved sheet drift.", {
        reason: "drift_detected"
      });
      return { ok: false, reason: "drift_detected", resetCount: 0 };
    }

    await deps.refreshAdminCache(deps.cache, config);
    await deps.preloadSheetSnapshots(deps.sheets, config, deps.cache, {
      force: true,
      structural: false,
      normalizeAliases: true
    });
    const resetResult = await deps.resetConflictedQueueEntries();

    logBot("[SelfHeal] Automatic roster repair completed; conflicted attendance re-queued.", {
      resetCount: resetResult.resetCount,
      currentMonth: roster.currentMonthTitle,
      nextMonth: roster.nextMonthTitle
    });
    return { ok: true, reason: "repaired", resetCount: resetResult.resetCount };
  } catch (error) {
    logBotError("[SelfHeal] Automatic roster repair failed; attendance remains queued.", {
      error: error.message
    });
    return { ok: false, reason: error.message, resetCount: 0 };
  } finally {
    rosterSyncInProgress = false;
  }
}

async function handleFlushAttendanceAdminAction(ctx, config, deps) {
  const adminBackMenu = Markup.inlineKeyboard([[
    Markup.button.callback("🔙 Back", "admin:main"),
    Markup.button.callback("❌ Close", "admin:close")
  ]]);
  const sendCompletionMessage = deps.sendCompletionMessage ?? deps.sendOrUpdateAdminMessage;
  const status = await deps.getAttendanceQueueStatus();

  if (status.queueDepth === 0) {
    const notes = [];
    if (status.conflictedCount > 0) {
      notes.push(`⚠️ ${status.conflictedCount} conflicted ${status.conflictedCount === 1 ? "entry remains" : "entries remain"} queued for automatic roster repair.`);
    }
    if (status.permanentlyFailedCount > 0) {
      notes.push(`❌ ${status.permanentlyFailedCount} attendance ${status.permanentlyFailedCount === 1 ? "entry" : "entries"} permanently failed after exhausting retries and cannot be recovered automatically. Check the logs for details.`);
    }
    await sendCompletionMessage(
      ctx,
      `✅ No pending attendance entries to push.${notes.length > 0 ? `\n\n${notes.join("\n\n")}` : ""}`,
      adminBackMenu
    );
    return;
  }

  logBot(`[Admin] Attendance push started.`, { queueDepth: status.queueDepth });

  if (!deps.selfHealAttempted) {
    await deps.sendOrUpdateAdminMessage(
      ctx,
      `📤 Pushing ${status.queueDepth} pending attendance ${status.queueDepth === 1 ? "entry" : "entries"} to Google Sheets…`
    );
  }

  let outcome = null;

  try {
    const result = await deps.flushAttendanceQueue(async (entries) => {
      outcome = await deps.reconcilePendingAttendanceWithSheets(deps.sheets, config, entries);
      return outcome;
    });

    const writtenCount = outcome?.writtenEventIds?.length ?? result.flushedEvents?.length ?? 0;
    const conflictedEvents = outcome?.conflictedEvents ?? [];
    const conflictedCount = conflictedEvents.length;
    const skippedCount = outcome?.skippedEvents?.length ?? 0;

    if (
      conflictedCount > 0 &&
      !deps.selfHealAttempted &&
      conflictedEvents.every((entry) => isAttendanceRosterRecoveryReason(entry.reason))
    ) {
      const repair = await selfHealAttendanceRosterForQueue(deps, config);

      if (repair.ok && repair.resetCount > 0) {
        logBot("[Admin] Retrying attendance push after automatic roster repair.", {
          resetCount: repair.resetCount
        });
        return handleFlushAttendanceAdminAction(ctx, config, {
          ...deps,
          selfHealAttempted: true
        });
      }
    }

    logBot("[Admin] Attendance push complete.", { written: writtenCount, skipped: skippedCount, conflicted: conflictedCount });

    // Refresh in-memory snapshot so summary view reflects the newly written data.
    await deps.preloadSheetSnapshots(deps.sheets, config, deps.cache, {});

    const parts = [];

    if (writtenCount > 0) {
      parts.push(`✅ ${writtenCount} ${writtenCount === 1 ? "entry" : "entries"} written to sheet.`);
    }

    if (skippedCount > 0) {
      parts.push(`⏭ ${skippedCount} already up to date.`);
    }

    if (conflictedCount > 0) {
      parts.push(
        `⚠️ ${conflictedCount} conflicted — automatic roster repair was attempted. ` +
        `Review Sync Roster and try again when the sheet layout is corrected.`
      );
    }

    if (parts.length === 0) {
      parts.push("✅ Queue flushed — no new data to write.");
    }

    await sendCompletionMessage(ctx, parts.join("\n"), adminBackMenu);
  } catch (error) {
    logBotError("[Admin] Attendance push failed.", { error: error.message });
    await sendCompletionMessage(
      ctx,
      `❌ Push could not complete: ${error.message}\n\nThe attendance remains queued. The bot will retry automatically, and a roster repair will be attempted when the error indicates a sheet-layout problem.`,
      adminBackMenu
    );
  }
}

/**
 * Shows all attendance entries that are queued locally but not yet pushed to
 * Google Sheets.  Groups them by date (newest-first) with a per-row breakdown
 * of appointment → status so the admin can see exactly what will be written on
 * the next push.  Also surfaces any conflicted entries so the admin knows a
 * Sync Roster is needed before those can be pushed.
 */
async function handleQueueStatusAdminAction(ctx, deps) {
  const [status, events] = await Promise.all([
    deps.getAttendanceQueueStatus(),
    deps.listPendingAttendanceEvents()
  ]);

  const pendingCount = status.queueDepth;
  const conflictedCount = status.conflictedCount;
  const permanentlyFailedCount = status.permanentlyFailedCount ?? 0;

  if (pendingCount === 0 && conflictedCount === 0 && permanentlyFailedCount === 0) {
    await deps.sendOrUpdateAdminMessage(
      ctx,
      "✅ No outstanding attendance entries — the queue is empty.",
      deps.buildAdminMenu()
    );
    return;
  }

  const lines = [];

  if (pendingCount > 0) {
    lines.push(`📬 ${pendingCount} outstanding attendance ${pendingCount === 1 ? "entry" : "entries"}`);

    // Group by date (YYYY-MM-DD strings), sort newest-first.
    const byDate = new Map();
    for (const event of events) {
      if (!byDate.has(event.date)) byDate.set(event.date, []);
      byDate.get(event.date).push(event);
    }

    const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
    for (const date of sortedDates) {
      lines.push(`\n📅 ${date}`);
      for (const event of byDate.get(date)) {
        lines.push(`• ${event.appointment} → ${event.status}`);
      }
    }
  }

  if (conflictedCount > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `⚠️ ${conflictedCount} conflicted ${conflictedCount === 1 ? "entry" : "entries"} — the bot will attempt roster repair before the next push. Use 🔄 Sync Roster for an immediate repair.`
    );
  }

  if (permanentlyFailedCount > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `❌ ${permanentlyFailedCount} permanently failed ${permanentlyFailedCount === 1 ? "entry" : "entries"} — exhausted all retries and cannot be recovered automatically. Check the bot logs for details.`
    );
  }

  await deps.sendOrUpdateAdminMessage(ctx, lines.join("\n"), deps.buildAdminMenu());
}

async function handleOptionsResetAction(ctx, config, deps) {
  const timeoutMs = deps.timeoutMs ?? 8000;
  const sendCompletionMessage = deps.sendCompletionMessage ?? deps.sendOrUpdateAdminMessage;

  await deps.sendOrUpdateAdminMessage(
    ctx,
    "Resetting attendance options and refreshing active sheets. This will stop early if Google Sheets is slow."
  );

  await waitForInteractiveIdle();

  await deps.resetAttendanceOptions();
  config.attendanceOptions = [...config.onboardingAttendanceOptions];

  try {
    await withUiOperationTimeout(
      "Attendance option reset",
      async () => (deps.withSheetOperation ?? withSheetOperation)(async () => {
        // syncRosterState → syncOnboardingRoster covers prev/current/next months.
        // ensureNextMonthSheetExists omitted — it would trigger a duplicate full sync.
        await deps.syncRosterState(deps.sheets, config);
        await deps.refreshAdminCache(deps.adminCache, config);
        await deps.preloadSheetSnapshots(deps.sheets, config, deps.adminCache, { force: true });
      }),
      timeoutMs
    );

    await sendCompletionMessage(
      ctx,
      "Attendance options have been reset to the settings.yaml default list.",
      buildAttendanceOptionsMenu()
    );
  } catch (error) {
    if (error?.name === "UiOperationTimeoutError") {
      await sendCompletionMessage(
        ctx,
        "Attendance options were reset locally. Google Sheets is still refreshing in the background; use Sync Roster later if needed.",
        buildSyncPendingMenu("admin:menu:options")
      );
      return;
    }
    logBotWarn("Attendance options were reset locally but Sheet sync is pending.", {
      error: error.message
    });
    await sendCompletionMessage(
      ctx,
      "Attendance options were reset locally, but Google Sheets sync is incomplete. Use Sync Roster to finish reconciliation.",
      buildSyncPendingMenu("admin:menu:options")
    );
  }
}

function registerBackgroundSchedules({ bot, sheets, config, adminCache, deps = {} }) {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const scheduleFn = deps.scheduleFn ?? cron.schedule;
  const refreshAttendanceOptionUsageFn = deps.refreshAttendanceOptionUsageFn ?? refreshAttendanceOptionUsage;
  const isReminderWorkingDayFn = deps.isReminderWorkingDayFn ?? isReminderWorkingDay;
  const listUsersFn = deps.listUsersFn ?? listUsers;
  const sendPromptToChatFn = deps.sendPromptToChatFn ?? sendPromptToChat;
  const usesDefaultPromptBuilder =
    !deps.buildAndSendAttendancePromptFn && !deps.sendPromptToChatFn;
  const buildAndSendAttendancePromptFn = deps.buildAndSendAttendancePromptFn ??
    (deps.sendPromptToChatFn
      ? async (targetBot, targetConfig, user, cache) => {
          const sendStartedAt = Date.now();
          await sendPromptToChatFn(targetBot, targetConfig, user.chatId, cache);
          return {
            chatId: user.chatId,
            awaitingAttendance: true,
            attendancePromptMessageIds: user.attendancePromptMessageIds ?? [],
            sendLatencyMs: Date.now() - sendStartedAt
          };
        }
      : buildAndSendAttendancePrompt);
  const batchUpdateUsersByChatIdFn = deps.batchUpdateUsersByChatIdFn ?? batchUpdateUsersByChatId;
  const cleanupExpiredAttendanceButtonsFn =
    deps.cleanupExpiredAttendanceButtonsFn ?? cleanupExpiredAttendanceButtons;
  const runDailySheetMaintenanceFn = deps.runDailySheetMaintenanceFn ?? runDailySheetMaintenance;
  const runStartupSheetCleanupFn = deps.runStartupSheetCleanupFn ?? runStartupSheetCleanup;

  // Startup: clean up the spreadsheet (remove protections + trim trailing blank rows)
  // BEFORE the first sync cycle so that subsequent spreadsheets.get calls return
  // less data.  Background sync cycles are blocked while cleanup runs.
  adminCache.syncManager.setMaintenanceRunning(true);
  const startupCleanupPromise = runStartupSheetCleanupFn(sheets, config.spreadsheetId)
    .catch((error) => {
      logBotError("[Startup] Sheet cleanup failed (non-fatal).", { error: error.message });
    })
    .finally(() => {
      adminCache.syncManager.setMaintenanceRunning(false);
    });

  // After cleanup, run the normal startup sync + attendance option sort.
  const startupSyncPromise = startupCleanupPromise
    .then(() => adminCache.syncManager.runCycle({ force: false, reason: "startup" }))
    .then(() => refreshAttendanceOptionUsageFn(sheets, config, adminCache))
    .catch((error) => {
      logBotError("Initial startup sync/sort failed.", { error: error.message });
    });

  // If maintenance hasn't run in over 22 hours, schedule it shortly after startup
  // rather than waiting until the next 2 AM cron.  Wait for the startup sync
  // to finish first so we don't flood the API.
  Promise.all([getLastStructuralMaintenanceAt(), getLastStructuralMaintenanceAttemptAt()])
    .then(([lastMaintenanceAt, lastAttemptAt]) => {
      const lastMaint = lastMaintenanceAt ? Date.parse(lastMaintenanceAt) : 0;
      const staleMs = 22 * 60 * 60 * 1000; // 22 hours — matches the 2 AM maintenance window

      if (Date.now() - lastMaint > staleMs) {
        // If a maintenance run was attempted recently (e.g. midnight cron just fired
        // and failed before this restart), skip deferred startup — the API is likely
        // still congested and we'd just burn retries. Let the next midnight cron retry.
        const lastAttempt = lastAttemptAt ? Date.parse(lastAttemptAt) : 0;
        const attemptCooldownMs = 2 * 60 * 60 * 1000; // 2 hours

        if (Date.now() - lastAttempt < attemptCooldownMs) {
          logBot("Skipping deferred startup maintenance — recent attempt detected.", {
            lastAttemptAt,
            cooldownRemainingSec: Math.round((attemptCooldownMs - (Date.now() - lastAttempt)) / 1000)
          });
          return;
        }

        logBot("Scheduling deferred startup maintenance.", {
          lastMaintenanceAt: lastMaintenanceAt ?? "never"
        });
        setTimeoutFn(async () => {
          try {
            // Wait for the startup sync cycle + option sort to finish before
            // issuing more API calls.
            await startupSyncPromise;
            const registryBeforeMaintenance = await getAppointmentRegistry();
            const maintenance = await runDailySheetMaintenanceFn(
              sheets,
              config,
              buildRegistrySheetReconciliationOptions(registryBeforeMaintenance)
            );
            await syncAppointmentRegistry(maintenance?.onboardingAppointments);
            await syncOnboardingCodeColumn(
              sheets,
              config,
              (await getAppointmentRegistry()).appointments.filter((entry) => entry.active)
            );
            await refreshAdminCache(adminCache, config);
            await refreshAttendanceOptionUsageFn(sheets, config, adminCache);
          } catch (error) {
            logBotError("Deferred startup maintenance failed.", { error: error.message });
          }
        }, 10_000);
      }
    })
    .catch(() => {
      // Non-fatal; the 2 AM cron will run maintenance at the next opportunity.
    });

  setIntervalFn(async () => {
    try {
      await adminCache.syncManager.runCycle({ force: false, reason: "background" });
    } catch (error) {
      logBotError("Background sheet preload failed.", { error: error.message });
    }
  }, 60 * 1000);

  setIntervalFn(async () => {
    try {
      const result = await cleanupExpiredAttendanceButtonsFn(bot.telegram);

      if (result.attempted > 0) {
        logBot("Expired attendance confirmation buttons cleaned.", result);
      }
    } catch (error) {
      logBotError("Attendance confirmation button cleanup failed.", {
        error: error.message
      });
    }
  }, 60 * 1000);

  setIntervalFn(async () => {
    let reconciliation;
    try {
      reconciliation = await adminCache.syncManager.runCycle({ force: true, reason: "five-minute" });
    } catch (error) {
      logBotError("Five-minute sheet reconciliation failed.", { error: error.message });
    }

    // Self-healing: detect and repair manual edits to appointment names in
    // month sheets.  Throttled by SELF_HEAL_COOLDOWN_MS (1 hour) so healing
    // never triggers more than once per cooldown window regardless of how
    // many 5-minute cycles elapse while the divergence persists.
    if (reconciliation?.monthSlicesRefreshed) {
      runSelfHealingCycle(sheets, config, adminCache).catch((error) => {
        logBotError("[SelfHeal] Unhandled error in self-healing cycle.", {
          error: error.message
        });
      });
    }
  }, 5 * 60 * 1000);

  // 2 AM SGT (18:00 UTC): full structural maintenance (sheet creation, row sync, layout, protections).
  // Runs at 2 AM rather than midnight to avoid peak Google API congestion.
  scheduleFn(
    "0 2 * * *",
    async () => {
      logBot("[Maint] 2 AM sheet maintenance starting.");
      // Block background sync cycles for the duration of maintenance so they don't
      // fire a redundant preload while runDailySheetMaintenance is running.
      adminCache.syncManager.setMaintenanceRunning(true);
      try {
        const registryBeforeMaintenance = await getAppointmentRegistry();
        const maintenance = await runDailySheetMaintenanceFn(
          sheets,
          config,
          buildRegistrySheetReconciliationOptions(registryBeforeMaintenance)
        );
        await syncAppointmentRegistry(maintenance?.onboardingAppointments);
        await syncOnboardingCodeColumn(
          sheets,
          config,
          (await getAppointmentRegistry()).appointments.filter((entry) => entry.active)
        );
        await refreshAdminCache(adminCache, config);
        await refreshAttendanceOptionUsageFn(sheets, config, adminCache);
        logBot("[Maint] 2 AM sheet maintenance complete.");
      } catch (error) {
        logBotError("[Maint] 2 AM sheet maintenance failed.", { error: error.message });
      } finally {
        adminCache.syncManager.setMaintenanceRunning(false);
      }
    },
    { timezone: config.timezone }
  );

  // 02:05 SGT: queue compaction only (cheap local file operation).
  scheduleFn(
    "5 2 * * *",
    async () => {
      try {
        const result = await compactAttendanceQueue();

        if (result.compacted) {
          logBot("[Maint] Nightly queue compaction complete.", { removedCount: result.removedCount });
        }
      } catch (error) {
        logBotError("[Maint] Nightly queue compaction failed.", { error: error.message });
      }
    },
    { timezone: config.timezone }
  );

  const scheduledReminderTimes = [
    config.firstReminderTime,
    config.secondReminderTime
  ].filter(Boolean);

  for (const reminderTime of scheduledReminderTimes) {
    const [hour, minute] = reminderTime.split(":");

    scheduleFn(
      `${Number(minute)} ${Number(hour)} * * *`,
      async () => {
        const now = new Date();
        const shouldSendReminder = await isReminderWorkingDayFn(now, config.timezone);

        if (!shouldSendReminder) {
          return;
        }

        const isFirstReminder = reminderTime === config.firstReminderTime;
        const startReminderRefresh = async () => {
          try {
            const result = await adminCache.syncManager.runCycle({
              force: true,
              reason: "reminder",
              ...(!isFirstReminder ? { essentialSnapshotRefresh: true } : {})
            });
            return {
              fresh: result?.monthSlicesRefreshed === true,
              deferred: result === null || result?.monthSlicesRefreshed === false,
              failed: false
            };
          } catch (error) {
            logBotWarn(
              `[Reminder] Sheet refresh failed before ${reminderTime} reminder.`,
              { error: error.message }
            );
            return { fresh: false, deferred: false, failed: true };
          }
        };

        // The first reminder always targets every bound user, so fresh Sheets
        // data is not needed to choose recipients. Start the cycle after the
        // broadcast activity flag is raised so its nonessential snapshot phase
        // defers. The second reminder must refresh first because it only targets
        // people whose attendance is still unfilled.
        if (!isFirstReminder) {
          const refresh = await startReminderRefresh();
          if (!refresh.fresh) {
            logBotWarn(
              `[Reminder] Skipping ${reminderTime} reminder because its essential attendance refresh was not fresh.`,
              refresh
            );
            return;
          }
        }

        const users = (await listUsersFn()).filter((user) => {
          if (!user.appointment) {
            return false;
          }

          if (isFirstReminder) {
            return true;
          }

          return hasUnfilledAttendance(adminCache, config, user.appointment, now);
        });

        const broadcastStartedAt = Date.now();
        const broadcastStartedAtIso = new Date(broadcastStartedAt).toISOString();
        const broadcastContext = usesDefaultPromptBuilder
          ? buildAttendancePromptBroadcastContext(config, now)
          : null;
        const sendPrompts = () => allSettledConcurrent(
          users.map((user) => (signal) =>
            buildAndSendAttendancePromptFn(
              bot,
              config,
              user,
              adminCache,
              broadcastContext,
              signal
            )
          ),
          TELEGRAM_SEND_CONCURRENCY
        );
        const promptJob = enqueueAttendancePromptBroadcast(() =>
          runWithBackgroundPriority(async () => {
            if (isFirstReminder) {
              void startReminderRefresh();
            }
            return sendPrompts();
          })
        );
        const promptResults = await promptJob.completion;
        logAttendancePromptBroadcast(
          `reminder:${reminderTime}`,
          broadcastStartedAt,
          promptResults
        );

        const promptedAt = new Date().toISOString();
        const patches = [];

        for (let i = 0; i < promptResults.length; i++) {
          if (promptResults[i].status === "fulfilled") {
            const {
              chatId,
              awaitingAttendance,
              attendancePromptMessageIds
            } = promptResults[i].value;
            patches.push({
              chatId,
              expectedAppointment: users[i].appointment,
              notSubmittedAfter: broadcastStartedAtIso,
              notPromptedAfter: broadcastStartedAtIso,
              patch: {
                awaitingAttendance,
                attendancePromptMessageIds,
                promptedAt
              }
            });
          } else {
            logBotError(`[Reminder] Failed to send ${reminderTime} prompt.`, {
              recipientIndex: i,
              error: promptResults[i].reason?.message
            });
          }
        }

        await batchUpdateUsersByChatIdFn(patches);
      },
      { timezone: config.timezone }
    );
  }
}

async function recoverAttendanceTransferJournal({
  journal,
  registry,
  sheets,
  config,
  transferAttendanceRowsFn = transferAttendanceRows,
  transferAppointmentBindingFn = transferAppointmentBinding,
  updateJournalFn = updateAttendanceTransferJournal,
  clearJournalFn = clearAttendanceTransferJournal
}) {
  if (!journal) {
    return { recovered: false, reason: "no_journal" };
  }

  if (journal.phase === "completed") {
    await clearJournalFn(journal.id);
    return { recovered: true, reason: "completed_journal_cleared" };
  }

  if (!["prepared", "copied", "binding_committed"].includes(journal.phase)) {
    return { recovered: false, reason: "operator_recovery_required" };
  }

  const source = registry.appointments.find((entry) => entry.appointment === journal.fromAppointment);
  const destination = registry.appointments.find((entry) => entry.appointment === journal.toAppointment);

  if (journal.phase === "prepared" || journal.phase === "copied") {
    const expectedBindingIdentity = journal.expectedFromBindingIdentity;
    if (!expectedBindingIdentity) {
      return { recovered: false, reason: "missing_binding_identity" };
    }

    // The registry commit can succeed just before the process advances the
    // journal from copied to binding_committed. Recognize only the exact
    // transferred identity; any other destination binding stays untouched.
    if (
      journal.phase === "copied" &&
      !source?.boundChatId &&
      hasTransferredAttendanceBindingIdentity(
        expectedBindingIdentity,
        destination
      )
    ) {
      await updateJournalFn(journal.id, "binding_committed");
      const cleanup = await completeAttendanceTransferCleanup({
        journal,
        sheets,
        config,
        transferAttendanceRowsFn,
        updateJournalFn,
        clearJournalFn
      });
      return cleanup.cleaned
        ? {
            recovered: true,
            reason: "cleanup_completed",
            cleanupResults: cleanup.attendanceResults
          }
        : {
            recovered: false,
            reason: "cleanup_blocked",
            cleanupResults: cleanup.attendanceResults
          };
    }

    if (
      !source?.boundChatId ||
      destination?.boundChatId ||
      getAppointmentBindingIdentity(source) !== expectedBindingIdentity
    ) {
      return { recovered: false, reason: "binding_state_mismatch" };
    }

    if (journal.phase === "prepared") {
      const copyResults = await transferAttendanceRowsFn(
        sheets,
        config,
        journal.fromAppointment,
        journal.toAppointment,
        { phase: "copy" }
      );
      if (isAttendanceTransferBlocked(copyResults)) {
        return { recovered: false, reason: "copy_blocked", copyResults };
      }
      await updateJournalFn(journal.id, "copied", {
        copiedSheets: copyResults.filter((entry) => entry.transferred).map((entry) => entry.title)
      });
    }

    const binding = await transferAppointmentBindingFn(
      journal.fromAppointment,
      journal.toAppointment,
      {
        expectedFromBindingIdentity: expectedBindingIdentity,
        // Copy completion is durable in the journal before this point. Do not
        // replay it while the storage lock is held; just revalidate and commit.
        prepare: async () => ({ ok: true })
      }
    );
    if (!binding.ok) {
      return { recovered: false, reason: "binding_commit_blocked", binding };
    }
    await updateJournalFn(journal.id, "binding_committed");
  }

  if (source?.boundChatId || !destination?.boundChatId) {
    // The committed phase is checked from the restart snapshot. The prepared
    // and copied phases just committed the binding through storage above.
    if (journal.phase === "binding_committed") {
      return { recovered: false, reason: "binding_state_mismatch" };
    }
  }

  const cleanup = await completeAttendanceTransferCleanup({
    journal,
    sheets,
    config,
    transferAttendanceRowsFn,
    updateJournalFn,
    clearJournalFn
  });
  if (!cleanup.cleaned) {
    return {
      recovered: false,
      reason: "cleanup_blocked",
      cleanupResults: cleanup.attendanceResults
    };
  }

  return { recovered: true, reason: "cleanup_completed", cleanupResults: cleanup.attendanceResults };
}

function hasTransferredAttendanceBindingIdentity(expectedFromBindingIdentity, destination) {
  if (!destination?.boundChatId || !expectedFromBindingIdentity) {
    return false;
  }

  const [, ...bindingParts] = String(expectedFromBindingIdentity).split("\u0000");
  if (bindingParts.length < 2) {
    return false;
  }

  return getAppointmentBindingIdentity(destination) ===
    `${destination.appointment}\u0000${bindingParts.join("\u0000")}`;
}

async function completeAttendanceTransferCleanup({
  journal,
  sheets,
  config,
  transferAttendanceRowsFn = transferAttendanceRows,
  updateJournalFn = updateAttendanceTransferJournal,
  clearJournalFn = clearAttendanceTransferJournal
}) {
  const attendanceResults = await transferAttendanceRowsFn(
    sheets,
    config,
    journal.fromAppointment,
    journal.toAppointment,
    { phase: "clear" }
  );
  if (isAttendanceTransferCleanupBlocked(attendanceResults)) {
    return { cleaned: false, attendanceResults };
  }

  await updateJournalFn(journal.id, "completed");
  await clearJournalFn(journal.id);
  return { cleaned: true, attendanceResults };
}

export async function createAttendanceBot(config) {
  await recoverStorageTransactions();
  const bot = new Telegraf(config.telegramBotToken, {
    telegram: {
      agent: ipv4HttpsAgent
    }
  });
  const sheets = await createGoogleSheetsClient(config);
  const pendingTransfer = await getAttendanceTransferJournal();
  if (pendingTransfer) {
    const registry = await getAppointmentRegistry();
    try {
      const recovery = await recoverAttendanceTransferJournal({
        journal: pendingTransfer,
        registry,
        sheets,
        config
      });
      if (recovery.recovered) {
        logBot("Recovered interrupted attendance transfer cleanup.", {
          fromAppointment: pendingTransfer.fromAppointment,
          toAppointment: pendingTransfer.toAppointment
        });
      } else {
        logBotWarn("Attendance transfer journal retained for safe operator recovery.", {
          reason: recovery.reason,
          phase: pendingTransfer.phase,
          fromAppointment: pendingTransfer.fromAppointment,
          toAppointment: pendingTransfer.toAppointment
        });
      }
    } catch (error) {
      logBotError("Attendance transfer recovery requires retry; journal retained.", {
        error: error.message,
        phase: pendingTransfer.phase,
        fromAppointment: pendingTransfer.fromAppointment,
        toAppointment: pendingTransfer.toAppointment
      });
    }
  }
  const adminCache = createAdminCache();
  adminCache.syncManager = createSyncManager({
    // Do NOT pass force:true — that triggers a forced spreadsheets.get (metadata) on every
    // flush attempt, which takes 10–15 s from this VPS and consistently hits the 15 s timeout.
    // The month-slice read inside reconcilePendingAttendanceWithSheets already uses force:true
    // for the individual sheet values (cheap), so dropping it here only skips the expensive
    // metadata re-fetch. The 15-minute metadata TTL keeps structural info fresh enough.
    flushQueue: async () =>
      withSheetOperation(async () =>
        flushAttendanceQueue((entries) => reconcilePendingAttendanceWithSheets(sheets, config, entries))
      ),
    flushQueueIntervalMs: ATTENDANCE_QUEUE_FLUSH_INTERVAL_MS,
    shouldFlushQueue: async () =>
      (await listPendingAttendanceEvents()).length >= ATTENDANCE_QUEUE_FLUSH_THRESHOLD,
    // refreshOnboarding is intentionally a no-op in the hot-path cycle.
    // Onboarding data is read as part of refreshMonthSlices (via refreshMonthSlice →
    // refreshOnboardingSlice with TTL). Full structural roster sync runs once a day
    // via the midnight maintenance cron.
    refreshOnboarding: async () => false,
    // Do NOT spread options.force into preloadSheetSnapshots. When the five-minute cycle
    // passes force:true, propagating it would trigger a forced spreadsheets.get metadata
    // call (10–15 s, borderline timeout) on every reconciliation. The onboarding TTL (2 min)
    // and month-slice TTL (60 s) guarantee fresh data without an explicit force flag.
    refreshMonthSlices: async (options = {}) => {
      const isEssential =
        options.essentialSnapshotRefresh === true ||
        options.reason === "foreground";
      if (!isEssential && shouldDeferSnapshotRefresh()) {
        logBot("Snapshot refresh deferred for broadcast headroom.", {
          reason: options.reason ?? "background"
        });
        return false;
      }

      return withSheetOperation(async () => {
        // Re-check after waiting for the logical Sheet transaction lock; a
        // broadcast may have started while this refresh was queued.
        if (!isEssential && shouldDeferSnapshotRefresh()) {
          return false;
        }
        try {
          const refreshSnapshots = () => preloadSheetSnapshots(sheets, config, adminCache, {
            structural: false,
            normalizeAliases: options.reason === "five-minute"
          });
          if (isEssential) {
            await refreshSnapshots();
          } else {
            await runAsNonessentialSnapshotRefresh(refreshSnapshots);
          }
          return true;
        } catch (error) {
          if (!isEssential && isSnapshotRefreshDeferredError(error)) {
            logBot("Snapshot refresh yielded after broadcast began.", {
              reason: options.reason ?? "background"
            });
            return false;
          }
          throw error;
        }
      });
    },
    refreshAdminCache: async () => {
      await refreshAdminCache(adminCache, config);
    }
  });

  refreshAdminCache(adminCache, config).catch((error) => {
    logBotError("Initial admin cache hydrate failed.", { error: error.message });
  });
  loadAttendanceSnapshotsFromLocalCache()
    .then((snapshotBundle) => {
      if (!snapshotBundle) {
        return;
      }

      adminCache.sheetSnapshots = snapshotBundle;
      adminCache.summaryMemo.clear();
      adminCache.summaryMemoVersion = snapshotBundle.synchronizedAt ?? null;
    })
    .catch((error) => {
      logBotError("Initial local snapshot hydrate failed.", { error: error.message });
    });

  // Every incoming Telegram update outranks maintenance, synchronization, and
  // broadcast work. Background schedulers yield at their next safe network
  // boundary until this update is fully handled.
  bot.use((_ctx, next) => runWithInteractivePriority(next));

  bot.use(
    session({
      defaultSession: () => ({
        awaitingAttendance: false,
        awaitingSecretCode: false,
        awaitingAppointmentAdd: false,
        awaitingAttendanceOptionAdd: false,
        awaitingIssueReport: false,
        awaitingSpreadsheetIdChange: false,
        awaitingWeeklyAttendance: false,
        departmentEditTarget: null,
        pendingInteraction: null,
        pendingTextInput: null,
        weeklyAttendanceFlowId: null,
        weeklyAttendanceDates: [],
        weeklyAttendanceIndex: 0,
        weeklyAttendanceResults: [],
        weeklyAttendanceEntries: []
      })
    })
  );

  bot.use(async (ctx, next) => {
    if (!isPrivateTelegramIdentity(ctx)) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(
          "For privacy, use this bot in a direct message.",
          { show_alert: true }
        ).catch(() => {});
      } else if (ctx.chat) {
        await ctx.reply(
          "For privacy, this bot only accepts commands in a direct message."
        ).catch(() => {});
      }
      return;
    }

    const storedUser = await getUserByChatId(ctx.chat.id);

    if (storedUser?.userId && String(storedUser.userId) !== String(ctx.from.id)) {
      logBotWarn("Rejected Telegram identity mismatch.");

      if (ctx.callbackQuery) {
        await ctx.answerCbQuery("Identity verification failed.", {
          show_alert: true
        }).catch(() => {});
      } else {
        await ctx.reply("Identity verification failed.").catch(() => {});
      }
      return;
    }

    return next();
  });

  bot.command("help", async (ctx) => {
    await sendHelp(ctx, config);
  });

  bot.command("manual", async (ctx) => {
    await sendHelp(ctx, config);
  });

  bot.command("cancel", async (ctx) => {
    await resetConversationState(ctx);
    await ctx.reply("Current step cancelled.", Markup.removeKeyboard());
  });

  bot.command("onboard", async (ctx) => {
    await handleOnboardCommand(ctx, config, {
      registerUser,
      ensureSheetReadiness,
      resetConversationState,
      askForSecretCode,
      sheets,
      adminCache
    });
  });

  bot.start(async (ctx) => {
    await registerUser(ctx);
    // /start is a deliberate escape hatch from any stale menu or text prompt.
    await resetConversationState(ctx);
    const user = await getUserByChatId(ctx.chat.id);

    if (!user?.appointment || !user?.onboardingCompletedAt) {
      await ctx.reply(
        [
          "Welcome. This bot records attendance into the monthly worksheet.",
          "To get started, enter the secret code assigned to your appointment."
        ].join("\n")
      );
      await askForSecretCode(ctx, config);
      return;
    }

    await renderHomeMenu(ctx, config, {
      user,
      cache: adminCache
    });
  });

  bot.command("attendance", async (ctx) => {
    await registerUser(ctx);
    await ensureSheetReadiness(sheets, config, adminCache);
    const user = await ensureUserBound(ctx, config);

    if (!user) {
      return;
    }

    await askAttendance(ctx, config, user, adminCache);
  });

  bot.command("week", async (ctx) => {
    await registerUser(ctx);
    await ensureSheetReadiness(sheets, config, adminCache);
    const user = await ensureUserBound(ctx, config);

    if (!user) {
      return;
    }

    const weekOffset = getWeekdayIndex(config.timezone) >= 5 ? 1 : 0;
    await startWeeklyAttendanceFlow(ctx, config, sheets, user, adminCache, weekOffset);
  });

  bot.command("options", async (ctx) => {
    await ctx.reply(`Available attendance codes:\n${config.attendanceOptions.join(", ")}`);
  });

  bot.command("me", async (ctx) => {
    const user = await getUserByChatId(ctx.chat.id);
    const appointment = user?.appointment || "Not bound";
    await ctx.reply(`Current appointment: ${appointment}`);
  });

  bot.command("myid", async (ctx) => {
    await ctx.reply(`Your chat ID is ${ctx.chat.id}`);
  });

  bot.command("lastupdate", async (ctx) => {
    const syncStatus = adminCache.syncManager?.getStatus() ?? {
      cycleInProgress: false,
      lastQueueFlushAt: 0,
      lastOnboardingRefreshAt: 0,
      lastMonthRefreshAt: 0,
      lastFiveMinuteReconcileAt: 0
    };
    const queueStatus = await getAttendanceQueueStatus();
    const preloadStatus = syncStatus.cycleInProgress
      ? "Background synchronisation is in progress."
      : "Background synchronisation is idle.";

    await ctx.reply(
      [
        "Google Sheets synchronisation status:",
        `Queue flush: ${formatSyncStatusTimestamp(syncStatus.lastQueueFlushAt, config.timezone)}`,
        `ONBOARDING refresh: ${formatSyncStatusTimestamp(syncStatus.lastOnboardingRefreshAt, config.timezone)}`,
        `Month slice refresh: ${formatSyncStatusTimestamp(syncStatus.lastMonthRefreshAt, config.timezone)}`,
        `Five-minute reconcile: ${formatSyncStatusTimestamp(syncStatus.lastFiveMinuteReconcileAt, config.timezone)}`,
        `Queue depth: ${queueStatus.queueDepth}`,
        `Conflicted writes: ${queueStatus.conflictedCount}`,
        `Permanently failed: ${queueStatus.permanentlyFailedCount}`,
        `Next retry: ${queueStatus.nextRetryAt ? formatSyncStatusTimestamp(queueStatus.nextRetryAt, config.timezone) : "No retry scheduled"}`,
        preloadStatus
      ].join("\n")
    );
  });

  bot.command("admin", async (ctx) => {
    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    await sendOrUpdateAdminMessage(ctx, buildAdminMenuDescription(), buildAdminMenu());
  });

  bot.command("promptall", async (ctx) => {
    await runAdminAction("promptall", ctx, bot, sheets, config, adminCache);
  });

  bot.command("codes", async (ctx) => {
    await runAdminAction("codes", ctx, bot, sheets, config, adminCache);
  });

  bot.command("syncroster", async (ctx) => {
    await runAdminAction("syncroster", ctx, bot, sheets, config, adminCache);
  });

  bot.command("pending", async (ctx) => {
    await runAdminAction("pending", ctx, bot, sheets, config, adminCache);
  });

  bot.command("invite", async (ctx) => {
    await handleInviteCommand(ctx, bot, config, {
      requireAdmin,
      ensureSheetReadiness,
      renderInviteSubmenu,
      getOnboardingInvite,
      buildInviteMessage,
      buildInviteReplyMarkup,
      sheets,
      adminCache
    });
  });

  bot.command("deregister", async (ctx) => {
    await registerUser(ctx);
    const registry = await getAppointmentRegistry();
    const target = registry.appointments.find(
      (entry) => entry.active && String(entry.boundChatId) === String(ctx.chat.id)
    );

    if (!target) {
      await ctx.reply("You are not currently onboarded.");
      return;
    }
    const interaction = beginInteraction(ctx, "self-deregister", {
      confirm: { expectedBindingIdentity: getAppointmentBindingIdentity(target) }
    }, { ttlMs: 2 * 60 * 1000 });
    await ctx.reply(
      [
        `Deregister from ${target.appointment}?`,
        "This removes your Telegram binding and rotates your registration code.",
        "You will need a fresh invitation to onboard again."
      ].join("\n"),
      buildSelfDeregisterMenu(interaction.id)
    );
  });

  bot.command("admins", async (ctx) => {
    await runAdminAction("admins", ctx, bot, sheets, config, adminCache);
  });

  bot.command("summary", async (ctx) => {
    await runAdminAction("summary", ctx, bot, sheets, config, adminCache);
  });

  bot.command("addadmin", async (ctx) => {
    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    await ensureSheetReadiness(sheets, config, adminCache);
    const appointment = getCommandArgument(ctx.message.text, "addadmin");

    if (!appointment) {
      await renderAddAdminSubmenu(ctx, adminCache, 0);
      return;
    }
    const registry = await getAppointmentRegistry();
    const target = registry.appointments.find(
      (entry) => entry.active && entry.appointment.toUpperCase() === appointment.toUpperCase()
    );
    if (!target) {
      await ctx.reply("Appointment not found in the active roster.");
      return;
    }
    if (!target.boundChatId) {
      await ctx.reply("That appointment is not currently onboarded and cannot be made an admin.");
      return;
    }
    const choice = {
      appointment: target.appointment,
      bindingIdentity: getAppointmentBindingIdentity(target),
      boundFullName: target.boundFullName || null
    };
    const interaction = beginInteraction(ctx, "admin-add-admin-confirm", {
      confirm: choice
    }, { ttlMs: 2 * 60 * 1000 });
    await ctx.reply(
      choice.boundFullName
        ? `Grant admin access to ${choice.appointment} (${choice.boundFullName})?`
        : `Grant admin access to ${choice.appointment}?`,
      Markup.inlineKeyboard([[
        Markup.button.callback("✅ Grant Admin", `admin:confirm:addadmin:${interaction.id}`),
        Markup.button.callback("↩️ Cancel", "admin:menu:admins")
      ]])
    );
  });

  bot.command("removeadmin", async (ctx) => {
    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    const appointment = getCommandArgument(ctx.message.text, "removeadmin");

    if (!appointment) {
      await renderRemoveAdminSubmenu(ctx, adminCache, 0);
      return;
    }
    const registry = await getAppointmentRegistry();
    const target = registry.appointments.find(
      (entry) => entry.active && entry.appointment.toUpperCase() === appointment.toUpperCase()
    );
    const isDefaultAdmin = config.defaultAdminAppointments.some(
      (entry) => entry.toUpperCase() === appointment.toUpperCase()
    );
    const isCustomAdmin = (registry.adminAppointments ?? []).some(
      (entry) => entry.toUpperCase() === appointment.toUpperCase()
    );
    if (isDefaultAdmin) {
      await ctx.reply("That is a default admin appointment and cannot be removed.");
      return;
    }
    if (!target || !isCustomAdmin) {
      await ctx.reply("That appointment does not currently have custom admin access.");
      return;
    }
    const choice = {
      appointment: target.appointment,
      bindingIdentity: getAppointmentBindingIdentity(target),
      boundFullName: target.boundFullName || null
    };
    const interaction = beginInteraction(ctx, "admin-remove-admin-confirm", {
      confirm: choice
    }, { ttlMs: 2 * 60 * 1000 });
    await ctx.reply(
      `Remove custom admin access from ${choice.appointment}${choice.boundFullName ? ` (${choice.boundFullName})` : ""}?`,
      Markup.inlineKeyboard([[
        Markup.button.callback("✅ Remove Admin", `admin:confirm:removeadmin:${interaction.id}`),
        Markup.button.callback("↩️ Cancel", "admin:menu:admins")
      ]])
    );
  });

  bot.command("addappointment", async (ctx) => {
    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    const appointment = getCommandArgument(ctx.message.text, "addappointment");

    if (!appointment) {
      beginTextInput(ctx, "appointment", { ttlMs: 10 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        "Send the appointment name exactly as it should appear in the roster.",
        buildAppointmentManagementBackMenu()
      );
      return;
    }
    const interaction = beginInteraction(ctx, "appointment-add", {
      confirm: { appointment }
    }, { ttlMs: 2 * 60 * 1000 });
    await ctx.reply(
      `Add ${appointment} to the active roster?`,
      Markup.inlineKeyboard([[
        Markup.button.callback("✅ Add Appointment", `admin:confirm:appointmentadd:${interaction.id}`),
        Markup.button.callback("↩️ Cancel", "admin:menu:roster")
      ]])
    );
  });

  bot.command("removeappointment", async (ctx) => {
    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    await ensureSheetReadiness(sheets, config, adminCache);
    const appointment = getCommandArgument(ctx.message.text, "removeappointment");

    if (!appointment) {
      await renderRemoveAppointmentSubmenu(ctx, adminCache, 0);
      return;
    }
    const registry = await getAppointmentRegistry();
    const target = registry.appointments.find(
      (entry) => entry.active && entry.appointment.toUpperCase() === appointment.toUpperCase()
    );
    if (!target) {
      await ctx.reply("Appointment not found in the active roster.");
      return;
    }
    const choice = {
      appointment: target.appointment,
      stateIdentity: getAppointmentStateIdentity(target),
      boundChatId: target.boundChatId || null,
      boundFullName: target.boundFullName || null
    };
    const interaction = beginInteraction(ctx, "admin-remove-appointment-confirm", {
      confirm: choice
    }, { ttlMs: 2 * 60 * 1000 });
    await ctx.reply(
      choice.boundChatId
        ? `Remove ${choice.appointment}${choice.boundFullName ? ` (${choice.boundFullName})` : ""} from the active roster? Their Telegram binding will also be removed.`
        : `Remove ${choice.appointment} from the active roster? This cannot be undone from Telegram.`,
      Markup.inlineKeyboard([[
        Markup.button.callback("✅ Remove Appointment", `admin:confirm:appointmentremove:${interaction.id}`),
        Markup.button.callback("↩️ Cancel", "admin:menu:roster")
      ]])
    );
  });

  bot.on("text", async (ctx) => {
    const message = ctx.message.text.trim();
    const storedUser = await getUserByChatId(ctx.chat.id);
    const awaitingSecretCode =
      ctx.session.awaitingSecretCode || storedUser?.awaitingSecretCode === true;
    const awaitingAttendance =
      ctx.session.awaitingAttendance || storedUser?.awaitingAttendance === true;
    let awaitingWeeklyAttendance =
      ctx.session.awaitingWeeklyAttendance || storedUser?.awaitingWeeklyAttendance === true;

    // Rehydrate a persisted weekly flow after restart. Only clear an inconsistent
    // awaiting flag when neither the session nor the stored user has week dates.
    if (awaitingWeeklyAttendance) {
      const hasFlowDates = (ctx.session.weeklyAttendanceDates?.length ?? 0) > 0;
      if (!hasFlowDates) {
        const persistedWeeklyState = getWeeklyAttendanceState(ctx, storedUser);

        if (persistedWeeklyState.dates.length > 0) {
          restoreWeeklyAttendanceSession(ctx, persistedWeeklyState);
        } else {
          await clearWeeklyAttendanceState(ctx);
          awaitingWeeklyAttendance = false;
        }
      }
    }
    const awaitingAttendanceOptionAdd = Boolean(getTextInput(ctx, "attendance-option"));
    const awaitingAppointmentAdd = Boolean(getTextInput(ctx, "appointment"));
    const awaitingIssueReport = Boolean(getTextInput(ctx, "issue"));
    const awaitingSpreadsheetIdChange = Boolean(getTextInput(ctx, "spreadsheet"));

    if (awaitingIssueReport) {
      const description = message.trim();

      if (!description) {
        // Keep awaitingIssueReport=true so the user can try again without
        // clicking the button again.
        await sendOrUpdateAdminMessage(
          ctx,
          "Issue description cannot be empty. Please try again.",
          Markup.inlineKeyboard([[
            Markup.button.callback("🔙 Back", "home:main"),
            Markup.button.callback("❌ Close", "home:close")
          ]])
        );
        return;
      }

      consumeTextInput(ctx, "issue");
      const titleText = description.length > 60 ? `${description.slice(0, 57)}…` : description;
      const issueTitle = `[User Report] ${titleText}`;
      const issueBody = [
        `**Date:** ${new Date().toISOString()}`,
        "",
        "**Description:**",
        description
      ].join("\n");

      let result;

      try {
        result = await submitGitHubIssue(issueTitle, issueBody);
      } catch (error) {
        logBotError("[GitHub] Unhandled error in submitGitHubIssue.", { error: error.message });
        result = { ok: false, reason: `unexpected_error:${error.message}` };
      }

      if (!result.ok) {
        const reason = result.reason === "no_token"
          ? "GitHub reporting is not configured on this bot. Please contact the administrator."
          : `Failed to submit the issue (${result.reason}). Please try again later.`;
        await ctx.reply(
          `❌ ${reason}`,
          Markup.inlineKeyboard([[
            Markup.button.callback("🔙 Back", "home:main"),
            Markup.button.callback("❌ Close", "home:close")
          ]])
        );
        return;
      }

      await ctx.reply(
        [
          `✅ Issue #${result.issueNumber} submitted successfully.`,
          "",
          "Thank you for your report! The development team will review it shortly."
        ].join("\n"),
        Markup.inlineKeyboard([[
          Markup.button.callback("🔙 Back", "home:main"),
          Markup.button.callback("❌ Close", "home:close")
        ]])
      );
      return;
    }

    if (awaitingSpreadsheetIdChange) {
      if (!(await requireAdmin(ctx, config))) {
        consumeTextInput(ctx, "spreadsheet");
        return;
      }

      const newId = message.trim();
      const adminBackMenu = Markup.inlineKeyboard([[
        Markup.button.callback("🔙 Back", "admin:menu:roster"),
        Markup.button.callback("❌ Close", "admin:close")
      ]]);

      if (!newId) {
        await ctx.reply("Spreadsheet ID cannot be empty. Please try again.", adminBackMenu);
        return;
      }

      // Basic sanity check: Google Sheets IDs are 40-character base58 strings.
      if (!/^[A-Za-z0-9_-]{20,}$/.test(newId)) {
        await ctx.reply(
          "That doesn't look like a valid Google Sheets spreadsheet ID. Please copy it from the sheet URL and try again.\n\nThe ID is the long alphanumeric string between /d/ and /edit in the URL.",
          adminBackMenu
        );
        return;
      }

      // This is intentionally the only foreground Sheets preflight added by
      // the hardening work: changing the target spreadsheet is rare and
      // high-impact, while normal attendance stays entirely local/queued.
      try {
        const metadata = await sheets.spreadsheets.get({
          spreadsheetId: newId,
          fields: "sheets.properties.title"
        });
        const titles = (metadata.data?.sheets ?? []).map((sheet) => sheet.properties?.title);
        if (!titles.includes(config.onboardingSheetTitle)) {
          await ctx.reply(
            `That spreadsheet is missing the required ${config.onboardingSheetTitle} sheet. The current spreadsheet remains active.`,
            adminBackMenu
          );
          return;
        }
      } catch (error) {
        logBotWarn("Spreadsheet change preflight failed.", { error: error.message });
        await ctx.reply(
          "I could not access that spreadsheet with the bot service account. The current spreadsheet remains active.",
          adminBackMenu
        );
        return;
      }

      consumeTextInput(ctx, "spreadsheet");
      const previousId = config.spreadsheetId;
      const confirmation = beginInteraction(ctx, "spreadsheet-change", {
        confirm: { newId, previousId }
      }, { ttlMs: 2 * 60 * 1000 });
      await ctx.reply(
        [
          "Confirm Target Spreadsheet Change",
          "",
          `Previous: <code>${escapeHtml(previousId)}</code>`,
          `New:      <code>${escapeHtml(newId)}</code>`,
          "",
          "The current spreadsheet remains active until you confirm."
        ].join("\n"),
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[
            Markup.button.callback("✅ Confirm Change", `admin:confirm:spreadsheet:${confirmation.id}`),
            Markup.button.callback("↩️ Cancel", "admin:menu:roster")
          ], [Markup.button.callback("❌ Close", "admin:close")]])
        }
      );
      return;
    }

    if (awaitingAppointmentAdd) {
      if (!(await requireAdmin(ctx, config))) {
        consumeTextInput(ctx, "appointment");
        return;
      }

      const normalizedAppointment = String(message ?? "").trim();

      if (!normalizedAppointment) {
        await sendOrUpdateAdminMessage(
          ctx,
          "Appointment name cannot be empty. Send the appointment name to add it.",
          buildAppointmentManagementBackMenu()
        );
        return;
      }

      consumeTextInput(ctx, "appointment");
      const confirmation = beginInteraction(ctx, "appointment-add", {
        confirm: { appointment: normalizedAppointment }
      }, { ttlMs: 2 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        `Add <b>${escapeHtml(normalizedAppointment)}</b> to the active roster?`,
        Markup.inlineKeyboard([[
          Markup.button.callback("✅ Add Appointment", `admin:confirm:appointmentadd:${confirmation.id}`),
          Markup.button.callback("↩️ Cancel", "admin:menu:roster")
        ]]),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (awaitingAttendanceOptionAdd) {
      if (!(await requireAdmin(ctx, config))) {
        consumeTextInput(ctx, "attendance-option");
        return;
      }

      const normalizedOption = String(message ?? "").trim().toUpperCase();

      if (!normalizedOption || /^[=+\-@]/.test(normalizedOption)) {
        await sendOrUpdateAdminMessage(
          ctx,
          "Attendance option must be non-empty and cannot begin with =, +, -, or @.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback("🔙 Back", "admin:menu:options"),
              Markup.button.callback("❌ Close", "admin:close")
            ]
          ])
        );
        return;
      }

      if (normalizedOption === "PCL" || normalizedOption === "PARENT CARE LEAVE") {
        consumeTextInput(ctx, "attendance-option");
        await sendOrUpdateAdminMessage(
          ctx,
          "PCL is retired and cannot be added. Use FCL instead.",
          buildAttendanceOptionsMenu()
        );
        return;
      }

      if (config.attendanceOptions.length >= 100) {
        consumeTextInput(ctx, "attendance-option");
        await sendOrUpdateAdminMessage(
          ctx,
          "The attendance option limit is 100. Remove an unused option before adding another.",
          buildAttendanceOptionsMenu()
        );
        return;
      }

      if (config.attendanceOptions.includes(normalizedOption)) {
        consumeTextInput(ctx, "attendance-option");
        await sendOrUpdateAdminMessage(
          ctx,
          `${normalizedOption} is already in the attendance option list.`,
          buildAttendanceOptionsMenu()
        );
        return;
      }

      consumeTextInput(ctx, "attendance-option");
      const confirmation = beginInteraction(ctx, "attendance-option-add", {
        confirm: { option: normalizedOption, expectedOptions: [...config.attendanceOptions] }
      }, { ttlMs: 2 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        `Add attendance option <b>${escapeHtml(normalizedOption)}</b>?`,
        Markup.inlineKeyboard([[
          Markup.button.callback("✅ Add Option", `admin:confirm:optionadd:${confirmation.id}`),
          Markup.button.callback("↩️ Cancel", "admin:menu:options")
        ]]),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (awaitingSecretCode) {
      await ensureSheetReadiness(sheets, config, adminCache);

      const binding = await bindAppointmentCode(normalizeSecretCode(message), {
        chatId: String(ctx.chat.id),
        userId: String(ctx.from.id),
        username: ctx.from.username || "",
        fullName: formatUserName(ctx.from)
      });

      if (!binding.ok) {
        const errorMessages = {
          invalid_code: "That secret code does not match any active appointment.",
          inactive_code:
            "That secret code belongs to an inactive appointment and cannot be used.",
          code_already_claimed:
            "That secret code has already been claimed by another Telegram account."
        };

        await ctx.reply(
          `${errorMessages[binding.reason] || "The secret code could not be used."} Try again or contact the admin.`,
          Markup.removeKeyboard()
        );
        return;
      }

      ctx.session.awaitingSecretCode = false;
      await updateUserByChatId(ctx.chat.id, {
        appointment: binding.appointment,
        onboardingSecretCode: binding.secretCode,
        awaitingSecretCode: false,
        onboardingCompletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await refreshAdminCache(adminCache, config);

      await ctx.reply(
        [
          `Onboarding complete. This Telegram account is now bound to "${binding.appointment}".`,
          "Use /start to open the menu any time."
        ].join("\n"),
        Markup.removeKeyboard()
      );
      await renderHomeMenu(ctx, config, {
        user: await getUserByChatId(ctx.chat.id),
        cache: adminCache
      });
      return;
    }

    if (awaitingWeeklyAttendance) {
      await sendOrUpdateAdminMessage(
        ctx,
        "Use the inline buttons to continue your weekly attendance update.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Back", "home:main"),
            Markup.button.callback("❌ Close", "home:close")
          ]
        ])
      );
      return;
    }

    if (!awaitingAttendance) {
      return;
    }

    await sendOrUpdateAdminMessage(
      ctx,
      "Use the inline buttons to submit today's attendance.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "home:main"),
          Markup.button.callback("❌ Close", "home:close")
        ]
      ])
    );
  });

  bot.catch((error, ctx) => {
    logBotError("[Telegram] Unhandled bot error.", { error: error.message, stack: error.stack });
    // "query is too old" means the user's tap expired before we answered it (Telegram's
    // ~90 s window).  The operation itself may have succeeded — don't send a spurious
    // "something went wrong" that contradicts a success message the user may have already
    // received or that will arrive shortly from an in-flight write.
    if (
      typeof error.message === "string" &&
      error.message.includes("query is too old")
    ) {
      return;
    }
    ctx.reply("Something went wrong while processing your request. Try again.").catch(() => {});
  });

  bot.action(/home:(.+)/, async (ctx) => {
    const action = ctx.match[1];
    const isWeeklyEntryAction = action === "week:this" || action === "week:next" || action === "week";

    if (
      !action.startsWith("pick:attendance:") &&
      !action.startsWith("department:pickoption:") &&
      !action.startsWith("pick:week:")
    ) {
      await ctx.answerCbQuery(isWeeklyEntryAction ? "Opening weekly attendance…" : undefined);
    }

    // Successful attendance confirmations reuse the original Telegram message.
    // If its Back/Close button is used, cancel the delayed cleanup before that
    // message is repurposed so the sweeper cannot strip a newer menu's buttons.
    if (action === "main" || action === "close") {
      await resetConversationState(ctx);
      await cancelAttendanceButtonCleanup(
        ctx.chat.id,
        getMessageId(ctx.callbackQuery?.message)
      ).catch((error) => {
        logBotError("Failed to cancel attendance confirmation button cleanup.", {
          error: error.message
        });
      });
    }

    if (action === "main") {
      await renderHomeMenu(ctx, config, { cache: adminCache });
      return;
    }

    if (action === "close") {
      await sendOrUpdateAdminMessage(ctx, "Menu closed.");
      return;
    }

    if (action === "attendance") {
      triggerBackgroundSheetRefresh(adminCache, "home:attendance");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      await askAttendance(ctx, config, user, adminCache);
      return;
    }

    if (action === "week") {
      triggerBackgroundSheetRefresh(adminCache, "home:week");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const weekOffset = getWeekdayIndex(config.timezone) >= 5 ? 1 : 0;
      await startWeeklyAttendanceFlow(ctx, config, sheets, user, adminCache, weekOffset);
      return;
    }

    if (action === "week:this" || action === "week:next") {
      triggerBackgroundSheetRefresh(
        adminCache,
        action === "week:next" ? "home:week:next" : "home:week:this"
      );
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const weekOffset = action === "week:next" ? 1 : 0;
      await startWeeklyAttendanceFlow(ctx, config, sheets, user, adminCache, weekOffset);
      return;
    }

    if (action === "department") {
      triggerBackgroundSheetRefresh(adminCache, "home:department");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      await renderDepartmentView(ctx, config, adminCache, user, {
        isAdminUser: await isAdmin(ctx, config)
      });
      return;
    }

    if (action.startsWith("department:view:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:department:view");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const [, , departmentKey, weekOffsetRaw, pageRaw] = action.split(":");
      await renderDepartmentView(ctx, config, adminCache, user, {
        departmentKey,
        weekOffset: Number(weekOffsetRaw ?? 0),
        page: Number(pageRaw ?? 0),
        isAdminUser: await isAdmin(ctx, config)
      });
      return;
    }

    if (action.startsWith("department:switch:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:department:switch");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      if (!(await isAdmin(ctx, config))) {
        await renderDepartmentView(ctx, config, adminCache, user, { isAdminUser: false });
        return;
      }

      const [, , departmentKey, weekOffsetRaw, pageRaw] = action.split(":");
      const viewModel = buildDepartmentWorkweekViewModel(adminCache, config, user, {
        departmentKey,
        weekOffset: Number(weekOffsetRaw ?? 0),
        page: Number(pageRaw ?? 0),
        isAdminUser: true
      });

      await sendOrUpdateAdminMessage(
        ctx,
        [
          "<b><u>Select Department</u></b>",
          "Choose a department to view and edit."
        ].join("\n\n"),
        buildDepartmentPickerMenu(
          viewModel.allDepartmentOptions,
          viewModel.weekOffset,
          viewModel.departmentKey,
          viewModel.page
        ),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (action.startsWith("department:select:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:department:select");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      await renderDepartmentView(ctx, config, adminCache, user, {
        departmentKey: action.split(":")[2],
        weekOffset: Number(action.split(":")[3] ?? 0),
        isAdminUser: await isAdmin(ctx, config)
      });
      return;
    }

    if (action.startsWith("department:edit:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:department:edit");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const [, , departmentKey, weekOffsetRaw, pageRaw, absoluteIndexRaw, dayIndexRaw, memberFingerprint] = action.split(":");
      const isAdminUser = await isAdmin(ctx, config);
      const viewModel = buildDepartmentWorkweekViewModel(adminCache, config, user, {
        departmentKey,
        weekOffset: Number(weekOffsetRaw ?? 0),
        page: Number(pageRaw ?? 0),
        isAdminUser
      });
      const targetMember = viewModel.members.find(
        (member) => member.absoluteIndex === Number(absoluteIndexRaw)
      );
      const dayIndex = Number(dayIndexRaw);
      const targetDate = viewModel.weekDates[dayIndex];

      if (
        !viewModel.ok ||
        !targetMember ||
        !targetDate ||
        stableSelectionFingerprint(targetMember.appointment) !== memberFingerprint
      ) {
        await rejectExpiredInteraction(ctx);
        await renderDepartmentView(ctx, config, adminCache, user, {
          departmentKey,
          weekOffset: Number(weekOffsetRaw ?? 0),
          page: Number(pageRaw ?? 0),
          isAdminUser
        });
        return;
      }

      const target = {
        appointment: targetMember.appointment,
        date: targetDate.toISOString(),
        departmentKey: viewModel.departmentKey,
        weekOffset: viewModel.weekOffset,
        page: viewModel.page
      };
      const interaction = beginInteraction(
        ctx,
        "department-attendance",
        Object.fromEntries(config.attendanceOptions.map((option, index) => [String(index), {
          option,
          optionFingerprint: attendanceStatusFingerprint(option)
        }])),
        { ttlMs: 10 * 60 * 1000, payload: target }
      );
      const currentStatus = getCachedAttendanceStatus(
        adminCache,
        config,
        targetMember.appointment,
        targetDate
      );
      const dateLabel = formatAttendanceDateLabel(targetDate, config.timezone);
      const promptMessage = currentStatus
        ? `Set ${targetMember.appointment}'s attendance for ${dateLabel}. Current: ${currentStatus}.`
        : `Set ${targetMember.appointment}'s attendance for ${dateLabel}.`;

      await sendOrUpdateAdminMessage(
        ctx,
        promptMessage,
        buildAttendanceGroupMenu(
          config,
          (groupKey) => `home:department:pickgroup:${interaction.id}:${groupKey}`,
          `home:department:view:${viewModel.departmentKey}:${viewModel.weekOffset}:${viewModel.page}`
        )
      );
      return;
    }

    if (action.startsWith("department:pickgroup:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:department:pickgroup");
      const user = await ensureUserBound(ctx, config);
      if (!user) return;

      const [, , interactionId, groupKey] = action.split(":");
      const current = getInteraction(ctx, interactionId, "department-attendance");
      const target = current?.payload;
      if (!target) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      if (!groupKey) {
        await sendOrUpdateAdminMessage(
          ctx,
          "Choose a category, then select an attendance status.",
          buildAttendanceGroupMenu(
            config,
            (nextGroupKey) => `home:department:pickgroup:${interactionId}:${nextGroupKey}`,
            `home:department:view:${target.departmentKey}:${target.weekOffset}:${target.page}`
          )
        );
        return;
      }

      const group = getAttendanceOptionGroups(config).find((entry) => entry.key === groupKey);
      if (!group) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const targetDate = new Date(target.date);
      const currentStatus = getCachedAttendanceStatus(adminCache, config, target.appointment, targetDate);
      const dateLabel = formatAttendanceDateLabel(targetDate, config.timezone);
      await sendOrUpdateAdminMessage(
        ctx,
        currentStatus
          ? `Set ${target.appointment}'s attendance for ${dateLabel}. Current: ${currentStatus}. Choose from ${group.label}.`
          : `Set ${target.appointment}'s attendance for ${dateLabel}. Choose from ${group.label}.`,
        buildAttendanceGroupOptionMenu(
          config,
          groupKey,
          `home:department:pickoption:${interactionId}`,
          `home:department:pickgroup:${interactionId}`
        )
      );
      return;
    }

    if (action.startsWith("department:pickpage:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:department:pickpage");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const [, , interactionId, pageRaw] = action.split(":");
      const current = getInteraction(ctx, interactionId, "department-attendance");
      const target = current?.payload;

      if (!target) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const page = Number(pageRaw ?? 0);
      const targetDate = new Date(target.date);
      const currentStatus = getCachedAttendanceStatus(
        adminCache,
        config,
        target.appointment,
        targetDate
      );
      const dateLabel = formatAttendanceDateLabel(targetDate, config.timezone);
      const promptMessage = currentStatus
        ? `Set ${target.appointment}'s attendance for ${dateLabel}. Current: ${currentStatus}.`
        : `Set ${target.appointment}'s attendance for ${dateLabel}.`;

      await sendOrUpdateAdminMessage(
        ctx,
        promptMessage,
        buildInlineAttendanceMenu(
          config.attendanceOptions,
          page,
          "home:department:pickoption",
          `home:department:pickpage:${interactionId}`,
          `home:department:view:${target.departmentKey}:${target.weekOffset}:${target.page}`
          , [], {
            itemTokenBuilder: (option, index) =>
              `${interactionId}:${index}:${attendanceStatusFingerprint(option)}`
          }
        )
      );
      return;
    }

    if (action.startsWith("department:pickoption:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:department:pickoption");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const [, , interactionId, optionIndexRaw, optionFingerprint] = action.split(":");
      const resolved = getInteraction(
        ctx,
        interactionId,
        "department-attendance",
        optionIndexRaw
      );
      const target = resolved?.interaction.payload;

      if (!target) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const picked = config.attendanceOptions[Number(optionIndexRaw)];

      if (
        !picked ||
        picked !== resolved.choice.option ||
        attendanceStatusFingerprint(picked) !== optionFingerprint ||
        resolved.choice.optionFingerprint !== optionFingerprint
      ) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const isAdminUser = await isAdmin(ctx, config);
      if (
        !isAdminUser &&
        getDepartmentKeyForAppointment(config, target.appointment) !==
          getDepartmentKeyForAppointment(config, user.appointment)
      ) {
        await rejectExpiredInteraction(ctx, "Your access changed. Nothing was changed.");
        return;
      }

      if (!consumeInteraction(ctx, interactionId, "department-attendance")) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const targetDate = new Date(target.date);
      await queueAttendanceSelection(
        adminCache,
        config,
        target.appointment,
        picked,
        targetDate,
        "department",
        `department:${interactionId}:${target.appointment}:${toIsoDateString(targetDate, config.timezone)}`
      );
      // Only acknowledge success after the local, fsynced queue append has
      // completed. Telegram may be ahead of Sheets, but it must never be ahead
      // of the durable local source of truth.
      await ctx.answerCbQuery("Attendance saved");
      await updateUserByChatId(ctx.chat.id, {
        awaitingAttendance: false,
        lastSubmittedAt: new Date().toISOString()
      });
      await renderDepartmentView(ctx, config, adminCache, user, {
        departmentKey: target.departmentKey,
        weekOffset: target.weekOffset,
        page: target.page,
        isAdminUser: await isAdmin(ctx, config),
        banner: `Updated ${target.appointment} to ${picked} for ${formatAttendanceDateLabel(targetDate, config.timezone)}.`
      });
      return;
    }

    if (action === "admin") {
      if (!(await requireAdmin(ctx, config))) {
        return;
      }

      await sendOrUpdateAdminMessage(ctx, buildAdminMenuDescription(), buildAdminMenu());
      return;
    }

    if (action === "help") {
      await sendHelp(ctx, config);
      return;
    }

    if (action === "reportissue") {
      beginTextInput(ctx, "issue", { ttlMs: 10 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        [
          "Report an Issue",
          "",
          "Describe the issue or bug you've encountered. Your message will be submitted as a GitHub issue on the stl_attendance_bot repository.",
          "",
          "Please be as specific as possible (what you did, what you expected, what happened instead)."
        ].join("\n"),
        Markup.inlineKeyboard([[
          Markup.button.callback("🔙 Back", "home:main"),
          Markup.button.callback("❌ Cancel", "home:reportissue:cancel")
        ]])
      );
      return;
    }

    if (action === "reportissue:cancel") {
      cancelInteractions(ctx);
      await renderHomeMenu(ctx, config, { cache: adminCache });
      return;
    }

    if (action.startsWith("attendance:groups:")) {
      const [, , promptId, isoDate, groupKey] = action.split(":");
      const user = await ensureUserBound(ctx, config);
      if (!user) return;

      const date = parseIsoDate(isoDate);
      const currentIsoDate = toIsoDateString(new Date(), config.timezone);
      if (!date || isoDate !== currentIsoDate) {
        await rejectExpiredInteraction(ctx, "This attendance prompt has expired. Nothing was changed.");
        return;
      }

      if (!groupKey) {
        await sendOrUpdateAdminMessage(
          ctx,
          "Choose a category, then select your attendance status.",
          buildAttendanceGroupMenu(
            config,
            (nextGroupKey) => `home:attendance:groups:${promptId}:${isoDate}:${nextGroupKey}`,
            "home:main"
          )
        );
        return;
      }

      const group = getAttendanceOptionGroups(config).find((entry) => entry.key === groupKey);
      if (!group) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const existingStatus = getCachedAttendanceStatus(adminCache, config, user.appointment, date);
      const label = formatAttendanceDateLabel(date, config.timezone);
      await sendOrUpdateAdminMessage(
        ctx,
        existingStatus
          ? `Your attendance for ${label} is currently ${existingStatus}. Select a status from ${group.label}.`
          : `Select a status from ${group.label} for ${label}.`,
        buildDatedAttendanceGroupMenu(
          config,
          date,
          groupKey,
          "home:pick:attendance",
          "home:attendance:groups:" + promptId + ":" + isoDate,
          [],
          { promptId }
        )
      );
      return;
    }

    if (action.startsWith("attendance:page:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:attendance:page");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const parts = action.split(":");
      const isLegacyPrompt = parts.length === 4;
      const promptId = isLegacyPrompt
        ? newAttendancePromptId()
        : parts[2];
      const isoDate = isLegacyPrompt ? parts[2] : parts[3];
      const pageRaw = isLegacyPrompt ? parts[3] : parts[4];
      const date = parseIsoDate(isoDate);
      const currentIsoDate = toIsoDateString(new Date(), config.timezone);

      if (!date || isoDate !== currentIsoDate) {
        await rejectExpiredInteraction(ctx, "This attendance prompt has expired. Nothing was changed.");
        return;
      }

      const page = Number(pageRaw);
      const label = formatAttendanceDateLabel(date, config.timezone);
      const existingStatus = getCachedAttendanceStatus(
        adminCache,
        config,
        user.appointment,
        date
      );
      const message = existingStatus
        ? `Your attendance for ${label} is currently ${existingStatus}. Select new status.`
        : `Select your attendance for ${label}.`;

      await sendOrUpdateAdminMessage(
        ctx,
        message,
        buildDatedAttendanceMenu(
          config,
          date,
          page,
          "home:pick:attendance",
          "home:attendance:page",
          "home:main",
          [],
          { promptId }
        )
      );
      return;
    }

    if (action.startsWith("pick:attendance:")) {
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const parts = action.split(":");
      const isLegacyPrompt = parts.length === 5;
      const promptId = isLegacyPrompt
        ? `legacy-${getMessageId(ctx.callbackQuery?.message) ?? "unknown"}`
        : parts[2];
      const isoDate = isLegacyPrompt ? parts[2] : parts[3];
      const optionIndexRaw = isLegacyPrompt ? parts[3] : parts[4];
      const optionFingerprint = isLegacyPrompt ? parts[4] : parts[5];
      const todayIsoDate = toIsoDateString(new Date(), config.timezone);
      const recordedAt = parseIsoDate(isoDate);
      const picked = config.attendanceOptions[Number(optionIndexRaw)];

      if (
        !recordedAt ||
        isoDate !== todayIsoDate ||
        !picked ||
        attendanceStatusFingerprint(picked) !== optionFingerprint
      ) {
        await rejectExpiredInteraction(ctx, "This attendance prompt has expired. Nothing was changed.");
        return;
      }

      await queueAttendanceSelection(
        adminCache,
        config,
        user.appointment,
        picked,
        recordedAt,
        "daily",
        buildDailyAttendanceIdempotencyKey(
          ctx.chat.id,
          promptId,
          isoDate,
          picked
        )
      );
      // The durable local append is normally fast; acknowledge only once it
      // succeeds so a positive Telegram confirmation cannot be lost on restart.
      await ctx.answerCbQuery("Attendance saved");
      const submittedAt = new Date();
      const confirmationLines = [
        `Attendance recorded as "${picked}" for ${user.appointment} for ${formatAttendanceDateLabel(recordedAt, config.timezone)} at ${formatMilitaryTime(submittedAt, config.timezone)} hrs.`,
        "Queued for Google Sheets sync.",
        "",
        `"${pickQuoteOrJoke()}"`
      ];

      if (isAfterAttendanceReminderCutoff(submittedAt, config.timezone)) {
        confirmationLines.splice(
          1,
          0,
          "Remember to record your attendance on time tomorrow, please.",
          ""
        );
      }

      ctx.session.awaitingAttendance = false;
      const currentMessageId = getMessageId(ctx.callbackQuery?.message);

      // Serialize against an expiring cleanup before changing this message's
      // markup. The delayed cleanup is per-message serialized with this
      // cancellation, so it cannot remove the freshly installed keyboard.
      await cancelAttendanceButtonCleanup(ctx.chat.id, currentMessageId).catch((error) => {
        logBotError("Failed to cancel prior attendance confirmation button cleanup.", {
          error: error.message
        });
      });

      // The queue append above is already durable. Complete the user-visible
      // response, persist state, and clean older reminders concurrently.
      await Promise.all([
        updateUserByChatId(ctx.chat.id, {
          awaitingAttendance: false,
          attendancePromptMessageIds: [],
          lastSubmittedAt: submittedAt.toISOString()
        }),
        scheduleAttendanceButtonCleanup(
          ctx.chat.id,
          currentMessageId,
          submittedAt
        ).catch((error) => {
          logBotError("Failed to schedule attendance confirmation button cleanup.", {
            error: error.message
          });
        }),
        sendOrUpdateAdminMessage(
          ctx,
          confirmationLines.join("\n"),
          Markup.inlineKeyboard([
            [
              Markup.button.callback("🔙 Back", "home:main"),
              Markup.button.callback("❌ Close", "home:close")
            ]
          ])
        ),
        removeObsoleteAttendancePromptMessages(
          ctx.telegram,
          ctx.chat.id,
          user.attendancePromptMessageIds,
          currentMessageId
        )
      ]);
      triggerBackgroundSheetRefresh(adminCache, "home:pick:attendance");
      return;
    }

    if (action.startsWith("week:page:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:week:page");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const [, , flowId, isoDate, pageRaw] = action.split(":");
      const weeklyState = getWeeklyAttendanceState(ctx, user);
      if (!flowId || flowId !== weeklyState.flowId) {
        await rejectExpiredInteraction(ctx, "This weekly prompt has expired.");
        return;
      }
      const dayIndex = weeklyState.dates.findIndex(
        (value) => toIsoDateString(new Date(value), config.timezone) === isoDate
      );

      if (dayIndex < 0) {
        await rejectExpiredInteraction(ctx, "This weekly prompt has expired. Nothing was changed.");
        return;
      }

      restoreWeeklyAttendanceSession(ctx, { ...weeklyState, index: dayIndex });
      await updateUserByChatId(ctx.chat.id, { weeklyAttendanceIndex: dayIndex });
      await promptWeeklyAttendanceDay(
        ctx,
        config,
        user,
        adminCache,
        Number(pageRaw)
      );
      return;
    }

    if (action.startsWith("week:overview:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:week:overview");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const [, , flowId, weekId] = action.split(":");
      const weeklyState = getWeeklyAttendanceState(ctx, user);
      const currentWeekId = weeklyState.dates[0]
        ? toIsoDateString(new Date(weeklyState.dates[0]), config.timezone)
        : "";

      if (!flowId || flowId !== weeklyState.flowId || !weekId || weekId !== currentWeekId) {
        await rejectExpiredInteraction(ctx, "This weekly prompt has expired. Nothing was changed.");
        return;
      }

      await ctx.answerCbQuery();
      await showWeeklyAttendanceOverview(ctx, config, user, adminCache);
      return;
    }

    if (action.startsWith("week:day:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:week:day");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const [, , flowId, isoDate] = action.split(":");
      const weeklyState = getWeeklyAttendanceState(ctx, user);
      if (!flowId || flowId !== weeklyState.flowId) {
        await rejectExpiredInteraction(ctx, "This weekly prompt has expired.");
        return;
      }
      const dayIndex = weeklyState.dates.findIndex(
        (value) => toIsoDateString(new Date(value), config.timezone) === isoDate
      );

      if (dayIndex < 0) {
        await rejectExpiredInteraction(ctx, "This weekly prompt has expired. Nothing was changed.");
        return;
      }

      restoreWeeklyAttendanceSession(ctx, {
        ...weeklyState,
        index: dayIndex
      });
      await updateUserByChatId(ctx.chat.id, { weeklyAttendanceIndex: dayIndex });
      await ctx.answerCbQuery();
      await promptWeeklyAttendanceDay(ctx, config, user, adminCache);
      return;
    }

    if (action.startsWith("week:groups:")) {
      const [, , flowId, isoDate, groupKey] = action.split(":");
      const user = await ensureUserBound(ctx, config);
      if (!user) return;

      const weeklyState = getWeeklyAttendanceState(ctx, user);
      const currentWeekId = weeklyState.dates[0]
        ? toIsoDateString(new Date(weeklyState.dates[0]), config.timezone)
        : "";
      const requestedDate = weeklyState.dates.find(
        (value) => toIsoDateString(new Date(value), config.timezone) === isoDate
      );
      if (!flowId || flowId !== weeklyState.flowId || !requestedDate) {
        await rejectExpiredInteraction(ctx, "This weekly prompt has expired. Nothing was changed.");
        return;
      }

      const overviewTarget = `home:week:overview:${flowId}:${currentWeekId}`;
      if (!groupKey) {
        await sendOrUpdateAdminMessage(
          ctx,
          "Choose a category, then select a status for the day.",
          buildAttendanceGroupMenu(
            config,
            (nextGroupKey) => `home:week:groups:${flowId}:${isoDate}:${nextGroupKey}`,
            overviewTarget
          )
        );
        return;
      }

      const group = getAttendanceOptionGroups(config).find((entry) => entry.key === groupKey);
      if (!group) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const date = new Date(requestedDate);
      const currentStatus = getStagedAttendanceStatus(
        weeklyState.entries,
        isoDate,
        (value) => toIsoDateString(value, config.timezone)
      ) || getCachedAttendanceStatus(adminCache, config, user.appointment, date);
      const label = formatAttendanceDateLabel(date, config.timezone);

      await sendOrUpdateAdminMessage(
        ctx,
        currentStatus
          ? `Your attendance for ${label} is currently ${currentStatus}. Select a status from ${group.label}.`
          : `Select a status from ${group.label} for ${label}.`,
        buildDatedAttendanceGroupMenu(
          config,
          date,
          groupKey,
          `home:pick:week:${flowId}`,
          `home:week:groups:${flowId}:${isoDate}`,
          [[Markup.button.callback(WEEK_SKIP_LABEL, `home:pick:week:${flowId}:${isoDate}:skip`)]],
          {}
        )
      );
      return;
    }

    if (action.startsWith("week:submit:")) {
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const [, , flowId, weekId] = action.split(":");
      const weeklyState = getWeeklyAttendanceState(ctx, user);
      const currentWeekId = weeklyState.dates[0]
        ? toIsoDateString(new Date(weeklyState.dates[0]), config.timezone)
        : "";

      if (!flowId || flowId !== weeklyState.flowId || !weekId || weekId !== currentWeekId) {
        await rejectExpiredInteraction(ctx, "This weekly prompt has expired. Nothing was changed.");
        return;
      }

      await ctx.answerCbQuery("Submitting…");
      const submitted = await finalizeWeeklyAttendanceFlow(
        ctx,
        config,
        user,
        adminCache
      );

      if (submitted) {
        triggerBackgroundSheetRefresh(adminCache, "home:week:submit");
      }
      return;
    }

    if (action.startsWith("pick:week:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:pick:week");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const storedUser = await getUserByChatId(ctx.chat.id);
      const weeklyState = getWeeklyAttendanceState(ctx, storedUser);
      const weeklyDates = weeklyState.dates;
      const [, , flowId, requestedIsoDate, optionIndexRaw, optionFingerprint] = action.split(":");
      if (!flowId || flowId !== weeklyState.flowId) {
        await rejectExpiredInteraction(ctx, "This weekly prompt has expired.");
        return;
      }
      const weeklyIndex = weeklyDates.findIndex(
        (value) => toIsoDateString(new Date(value), config.timezone) === requestedIsoDate
      );
      const weeklyEntries = weeklyState.entries;
      const dateValue = weeklyDates[weeklyIndex];

      if (!dateValue) {
        await ctx.answerCbQuery();
        await clearWeeklyAttendanceState(ctx);
        await sendOrUpdateAdminMessage(
          ctx,
          "Weekly attendance flow expired. Run /week to start again.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback("🔙 Back", "home:main"),
              Markup.button.callback("❌ Close", "home:close")
            ]
          ])
        );
        return;
      }

      const date = new Date(dateValue);
      const isoDate = toIsoDateString(date, config.timezone);
      const currentStatus =
        getStagedAttendanceStatus(
          weeklyEntries,
          isoDate,
          (value) => toIsoDateString(value, config.timezone)
        ) ||
        getCachedAttendanceStatus(adminCache, config, user.appointment, date);
      let nextEntries = weeklyEntries;

      if (optionIndexRaw !== "skip") {
        const picked = config.attendanceOptions[Number(optionIndexRaw)];

        if (
          !picked ||
          attendanceStatusFingerprint(picked) !== optionFingerprint
        ) {
          await rejectExpiredInteraction(ctx, "This weekly prompt has expired. Nothing was changed.");
          return;
        }

        nextEntries = upsertWeeklyAttendanceEntry(
          weeklyEntries,
          isoDate,
          picked,
          (value) => toIsoDateString(value, config.timezone)
        );
        await ctx.answerCbQuery(`Saved: ${picked}`);
      } else if (currentStatus) {
        await ctx.answerCbQuery("Kept current status");
      } else {
        await ctx.answerCbQuery("Skipped");
      }

      restoreWeeklyAttendanceSession(ctx, {
        ...weeklyState,
        index: weeklyIndex,
        entries: nextEntries
      });

      await updateUserByChatId(ctx.chat.id, {
        weeklyAttendanceIndex: weeklyIndex,
        weeklyAttendanceEntries: nextEntries,
        lastSubmittedAt: new Date().toISOString()
      });

      await showWeeklyAttendanceOverview(ctx, config, user, adminCache);
      return;
    }

    if (action === "deregister") {
      const registry = await getAppointmentRegistry();
      const target = registry.appointments.find(
        (entry) => entry.active && String(entry.boundChatId) === String(ctx.chat.id)
      );
      if (!target) {
        await sendOrUpdateAdminMessage(ctx, "You are not currently onboarded.", buildHomeMenu(false, config.timezone));
        return;
      }
      const interaction = beginInteraction(ctx, "self-deregister", {
        confirm: { expectedBindingIdentity: getAppointmentBindingIdentity(target) }
      }, { ttlMs: 2 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        [
          "Warning",
          "Deregistering will remove your Telegram binding immediately.",
          "Your registration code will be rotated.",
          "You will need a fresh invitation to onboard again."
        ].join("\n"),
        buildSelfDeregisterMenu(interaction.id)
      );
      return;
    }

    if (action.startsWith("deregister:confirm:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "self-deregister", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "self-deregister")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const result = await deregisterRequestorByChatId(ctx.chat.id, {
        expectedBindingIdentity: resolved.choice.expectedBindingIdentity
      });

      if (!result.ok) {
        const messages = {
          not_bound: "You are not currently onboarded."
        };
        await sendOrUpdateAdminMessage(
          ctx,
          messages[result.reason] || "Unable to deregister your account.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback("🔙 Back", "home:main"),
              Markup.button.callback("❌ Close", "home:close")
            ]
          ])
        );
        return;
      }

      await refreshAdminCache(adminCache, config);
      await sendOrUpdateAdminMessage(
        ctx,
        [
          `You have been deregistered from ${result.appointment}.`,
          "Your previous registration code has been rotated.",
          "You will need a fresh invitation code to onboard again."
        ].join("\n"),
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Back", "home:main"),
            Markup.button.callback("❌ Close", "home:close")
          ]
        ])
      );
      return;
    }

    if (action === "deregister:confirm") {
      await rejectExpiredInteraction(ctx);
      return;
    }

    if (action === "summary") {
      const targetDate = new Date();
      triggerBackgroundSheetRefresh(adminCache, "home:summary");
      await renderCachedSummaryOrWarmup(ctx, adminCache, config, targetDate, "home:main");
      return;
    }

    if (action.startsWith("summary:unaccounted:")) {
      const targetDate = parseIsoDate(action.split(":")[2]);

      if (!targetDate) {
        await renderHomeMenu(ctx, config, { cache: adminCache });
        return;
      }

      if (!(await isReminderWorkingDay(targetDate, config.timezone))) {
        await renderCachedSummaryOrWarmup(ctx, adminCache, config, targetDate, "home:main");
        return;
      }

      const registry = await getAppointmentRegistry();
      const unaccountedAppointments = getUnaccountedAppointments(adminCache, config, targetDate);
      const boundRows = [];
      const unbound = [];

      for (const appointment of unaccountedAppointments) {
        const entry = registry.appointments.find(
          (value) => value.appointment.toUpperCase() === appointment.toUpperCase()
        );
        const url = buildChatUrlForRegistryEntry(entry);

        if (url) {
          boundRows.push([{
            text: appointment,
            url
          }]);
        } else {
          unbound.push(appointment);
        }
      }

      const lines = [
        `Unaccounted for ${formatAttendanceDateLabel(targetDate, config.timezone)}:`
      ];

      if (unaccountedAppointments.length === 0) {
        lines.push("No personnel are currently unaccounted.");
      } else {
        lines.push(...unaccountedAppointments.map((appointment) => `• ${appointment}`));
      }

      if (unbound.length > 0) {
        lines.push("");
        lines.push("No Telegram chat available for:");
        lines.push(...unbound.map((appointment) => `• ${appointment}`));
      }

      await sendOrUpdateAdminMessage(
        ctx,
        lines.join("\n"),
        buildUnaccountedMenu(targetDate, config.timezone, boundRows, "home:main", "home")
      );
      return;
    }

    if (action.startsWith("summary:")) {
      const targetDate = parseIsoDate(action.split(":")[1]);

      if (!targetDate) {
        await renderHomeMenu(ctx, config, { cache: adminCache });
        return;
      }

      triggerBackgroundSheetRefresh(adminCache, "home:summary:date");
      await renderCachedSummaryOrWarmup(ctx, adminCache, config, targetDate, "home:main");
      return;
    }
  });

  bot.action(/manual:(.+)/, async (ctx) => {
    const sectionKey = ctx.match[1];
    // Ignore "query is too old" — happens when a stale button is pressed and is harmless.
    await ctx.answerCbQuery().catch(() => {});
    const isAdminUser = await isAdmin(ctx, config);
    await sendOrUpdateAdminMessage(
      ctx,
      buildManualText(sectionKey, isAdminUser),
      buildManualMenu(isAdminUser)
    );
  });

  bot.action(/admin:(.+)/, async (ctx) => {
    const action = ctx.match[1];
    // Ignore "query is too old" — happens when a stale button is pressed and is harmless.
    await ctx.answerCbQuery().catch(() => {});

    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    if (action === "main") {
      await resetConversationState(ctx);
      await sendOrUpdateAdminMessage(ctx, buildAdminMenuDescription(), buildAdminMenu());
      return;
    }

    if (action === "close") {
      await resetConversationState(ctx);
      await ctx.editMessageText("Admin menu closed.");
      return;
    }

    if (action === "menu:roster") {
      cancelInteractions(ctx);
      await sendOrUpdateAdminMessage(ctx, buildRosterDescription(), buildAdminRosterMenu());
      return;
    }

    if (action === "menu:options") {
      cancelInteractions(ctx);
      await renderAttendanceOptionsMenu(ctx, config);
      return;
    }

    if (action.startsWith("menu:invite:")) {
      triggerBackgroundSheetRefresh(adminCache, "admin:menu:invite");
      await renderInviteSubmenu(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action.startsWith("menu:deregister:")) {
      triggerBackgroundSheetRefresh(adminCache, "admin:menu:deregister");
      await renderDeregisterSubmenu(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action === "appointments:add") {
      beginTextInput(ctx, "appointment", { ttlMs: 10 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        "Send the appointment name exactly as it should appear in the roster.",
        buildAppointmentManagementBackMenu()
      );
      return;
    }

    if (action.startsWith("menu:appointments:remove:")) {
      triggerBackgroundSheetRefresh(adminCache, "admin:menu:appointments:remove");
      await renderRemoveAppointmentSubmenu(ctx, adminCache, Number(action.split(":")[3]));
      return;
    }

    if (action.startsWith("menu:transfer:")) {
      triggerBackgroundSheetRefresh(adminCache, "admin:menu:transfer");
      await renderTransferFromSubmenu(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action.startsWith("menu:transferto:")) {
      // Pagination within the "to" selection carries an immutable fingerprint
      // for the source so a cache refresh cannot change the selected person.
      const parts = action.split(":");
      const fromIdx = Number(parts[2]);
      const fromFingerprint = parts[3];
      const page = Number(parts[4] ?? 0);
      await renderTransferToSubmenu(
        ctx,
        adminCache,
        fromIdx,
        fromFingerprint,
        page
      );
      return;
    }

    if (action === "menu:admins") {
      cancelInteractions(ctx);
      await sendOrUpdateAdminMessage(
        ctx,
        buildManageAdminsDescription(
          adminCache.admins,
          adminCache.activeCodes,
          config.defaultAdminAppointments
        ),
        buildAdminManageMenu()
      );
      return;
    }

    if (action.startsWith("menu:codes:")) {
      triggerBackgroundSheetRefresh(adminCache, "admin:menu:codes");
      await renderCodesSubmenuPage(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action.startsWith("menu:addadmin:")) {
      triggerBackgroundSheetRefresh(adminCache, "admin:menu:addadmin");
      await renderAddAdminSubmenu(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action.startsWith("menu:removeadmin:")) {
      triggerBackgroundSheetRefresh(adminCache, "admin:menu:removeadmin");
      await renderRemoveAdminSubmenu(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action === "options:add") {
      beginTextInput(ctx, "attendance-option", { ttlMs: 10 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        "Send the new attendance option code exactly as you want it to appear.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Back", "admin:menu:options"),
            Markup.button.callback("❌ Close", "admin:close")
          ]
        ])
      );
      return;
    }

    if (action.startsWith("options:remove:")) {
      await renderAttendanceOptionRemovalMenu(ctx, config, Number(action.split(":")[2]));
      return;
    }

    if (action === "options:reset") {
      const confirmation = beginInteraction(ctx, "attendance-options-reset", {
        confirm: { expectedOptions: [...config.attendanceOptions] }
      }, { ttlMs: 2 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        "Reset all attendance options to the configured defaults? Existing sheet values are preserved, but future menus will change.",
        Markup.inlineKeyboard([[
          Markup.button.callback("✅ Reset Options", `admin:confirm:optionsreset:${confirmation.id}`),
          Markup.button.callback("↩️ Cancel", "admin:menu:options")
        ]])
      );
      return;
    }

    if (action === "options:sort") {
      await sendOrUpdateAdminMessage(
        ctx,
        "Refreshing attendance option usage from recent sheets. This will stop early if Google Sheets is slow."
      );

      try {
        await withUiOperationTimeout(
          "Attendance option usage refresh",
          async () => {
            await refreshAttendanceOptionUsage(sheets, config, adminCache);
          }
        );
        await sendOrUpdateAdminMessage(
          ctx,
          "Attendance option usage has been refreshed. Categories stay in the configured order; options within each category are now sorted by recent usage.",
          buildAttendanceOptionsMenu()
        );
      } catch (error) {
        if (error?.name === "UiOperationTimeoutError") {
          await sendOrUpdateAdminMessage(
            ctx,
            "Attendance option usage refresh is taking too long because Google Sheets is slow. Please try again later."
          );
          return;
        }

        throw error;
      }
      return;
    }

    if (action.startsWith("confirm:addadmin:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "admin-add-admin-confirm", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "admin-add-admin-confirm")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const result = await addAdminAppointment(resolved.choice.appointment, {
        expectedBindingIdentity: resolved.choice.bindingIdentity
      });
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? `${result.appointment} now has admin access.`
          : "That appointment changed before confirmation. Nothing was changed.",
        buildAdminManageMenu()
      );
      await refreshAdminCache(adminCache, config);
      return;
    }

    if (action.startsWith("confirm:removeadmin:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "admin-remove-admin-confirm", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "admin-remove-admin-confirm")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const result = await removeAdminAppointment(
        resolved.choice.appointment,
        config.defaultAdminAppointments,
        { expectedBindingIdentity: resolved.choice.bindingIdentity }
      );
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? `${result.appointment} no longer has custom admin access.`
          : "That admin assignment changed before confirmation. Nothing was changed.",
        buildAdminManageMenu()
      );
      await refreshAdminCache(adminCache, config);
      return;
    }

    if (action.startsWith("confirm:deregister:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "admin-deregister-confirm", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "admin-deregister-confirm")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const result = await deregisterAppointmentBinding(resolved.choice.appointment, {
        expectedBindingIdentity: resolved.choice.bindingIdentity
      });
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? `Deregistered ${result.appointment}. The person will need to onboard again.`
          : "That binding changed before confirmation. Nothing was changed.",
        Markup.inlineKeyboard([[
          Markup.button.callback("🔙 Back", "admin:menu:deregister:0"),
          Markup.button.callback("❌ Close", "admin:close")
        ]])
      );
      await refreshAdminCache(adminCache, config);
      return;
    }

    if (action.startsWith("confirm:appointmentremove:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "admin-remove-appointment-confirm", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "admin-remove-appointment-confirm")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const result = await removeManagedAppointment(
        sheets,
        config,
        adminCache,
        resolved.choice.appointment,
        { expectedStateIdentity: resolved.choice.stateIdentity }
      );
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? result.syncPending
            ? `${result.appointment} was removed locally. Google Sheets sync is incomplete; use Sync Roster to finish reconciliation.`
            : `${result.appointment} has been removed from the active roster.`
          : "That appointment changed before confirmation. Nothing was changed.",
        result.syncPending
          ? buildSyncPendingMenu("admin:menu:roster")
          : buildAppointmentManagementBackMenu()
      );
      return;
    }

    if (action.startsWith("confirm:spreadsheet:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "spreadsheet-change", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "spreadsheet-change")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      if (config.spreadsheetId !== resolved.choice.previousId) {
        await rejectExpiredInteraction(ctx, "The target spreadsheet changed. Nothing was changed.");
        return;
      }
      const updateResult = await updateEnvSpreadsheetId(resolved.choice.newId, config);
      if (!updateResult.ok) {
        await sendOrUpdateAdminMessage(
          ctx,
          "Unable to update the spreadsheet setting. The previous spreadsheet remains active.",
          buildAdminRosterMenu()
        );
        return;
      }
      adminCache.sheetSnapshots = null;
      adminCache.summaryMemoVersion = null;
      runWithBackgroundPriority(() =>
        preloadSheetSnapshots(sheets, config, adminCache, { force: true, structural: true })
      ).catch(
        (error) => logBotError("[SpreadsheetChange] Background reload failed.", { error: error.message })
      );
      await sendOrUpdateAdminMessage(
        ctx,
        "✅ Spreadsheet ID updated. The new spreadsheet is loading in the background.",
        buildAdminRosterMenu()
      );
      return;
    }

    if (action.startsWith("confirm:appointmentadd:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "appointment-add", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "appointment-add")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const result = await addManagedAppointment(sheets, config, adminCache, resolved.choice.appointment);
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? result.syncPending
            ? `${result.appointment} was added locally.\nSecret code: ${result.secretCode}\nGoogle Sheets sync is incomplete; use Sync Roster to finish reconciliation.`
            : `${result.appointment} has been added to the active roster.\nSecret code: ${result.secretCode}`
          : result.reason === "appointment_exists"
            ? `${result.appointment} is already in the active roster.`
            : "Unable to add that appointment.",
        result.syncPending
          ? buildSyncPendingMenu("admin:menu:roster")
          : buildAppointmentManagementBackMenu()
      );
      return;
    }

    if (action.startsWith("confirm:optionadd:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "attendance-option-add", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "attendance-option-add")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const { option, expectedOptions } = resolved.choice;
      if (
        expectedOptions.length !== config.attendanceOptions.length ||
        expectedOptions.some((entry, index) => entry !== config.attendanceOptions[index]) ||
        config.attendanceOptions.includes(option)
      ) {
        await rejectExpiredInteraction(ctx, "Attendance options changed. Nothing was changed.");
        return;
      }
      const result = await applyAttendanceOptionChange(
        sheets,
        config,
        adminCache,
        [...config.attendanceOptions, option]
      );
      await sendOrUpdateAdminMessage(
        ctx,
        result.syncPending
          ? `${option} was added locally. Google Sheets sync is incomplete; use Sync Roster to finish reconciliation.`
          : `${option} has been added to the attendance options.`,
        result.syncPending
          ? buildSyncPendingMenu("admin:menu:options")
          : buildAttendanceOptionsMenu()
      );
      return;
    }

    if (action.startsWith("confirm:optionremove:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "attendance-option-remove", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "attendance-option-remove")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const { option, expectedOptions } = resolved.choice;
      if (
        !Array.isArray(expectedOptions) ||
        expectedOptions.length !== config.attendanceOptions.length ||
        expectedOptions.some((entry, index) => entry !== config.attendanceOptions[index]) ||
        !config.attendanceOptions.includes(option)
      ) {
        await rejectExpiredInteraction(ctx, "Attendance options changed. Nothing was changed.");
        return;
      }
      if (config.attendanceOptions.length === 1) {
        await rejectExpiredInteraction(ctx, "At least one attendance option must remain. Nothing was changed.");
        return;
      }
      const result = await applyAttendanceOptionChange(
        sheets,
        config,
        adminCache,
        config.attendanceOptions.filter((entry) => entry !== option)
      );
      await sendOrUpdateAdminMessage(
        ctx,
        result.syncPending
          ? `${option} was removed locally. Google Sheets sync is incomplete; use Sync Roster to finish reconciliation.`
          : `${option} has been removed from the attendance options.`,
        result.syncPending
          ? buildSyncPendingMenu("admin:menu:options")
          : buildAttendanceOptionsMenu()
      );
      return;
    }

    if (action.startsWith("confirm:optionsreset:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "attendance-options-reset", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "attendance-options-reset")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const { expectedOptions } = resolved.choice;
      if (
        !Array.isArray(expectedOptions) ||
        expectedOptions.length !== config.attendanceOptions.length ||
        expectedOptions.some((entry, index) => entry !== config.attendanceOptions[index])
      ) {
        await rejectExpiredInteraction(ctx, "Attendance options changed. Nothing was changed.");
        return;
      }
      runWithBackgroundPriority(() => handleOptionsResetAction(ctx, config, {
        resetAttendanceOptions,
        syncRosterState,
        refreshAdminCache,
        preloadSheetSnapshots,
        sendOrUpdateAdminMessage,
        sendCompletionMessage: (_ctx, message, replyMarkup, extraOptions) =>
          sendBackgroundBotMessage(
            bot,
            ctx.chat.id,
            message,
            replyMarkup,
            extraOptions
          ),
        sheets,
        adminCache
      })).catch((error) => {
        logBotError("[Admin] Attendance option reset failed.", { error: error.message });
      });
      return;
    }

    if (action.startsWith("confirm:clearprotections:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "clear-protections", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "clear-protections")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      runWithBackgroundPriority(() => handleClearProtectionsAdminAction(ctx, config, {
        clearAllSheetProtections,
        sendOrUpdateAdminMessage,
        sendCompletionMessage: (_ctx, message, replyMarkup, extraOptions) =>
          sendBackgroundBotMessage(
            bot,
            ctx.chat.id,
            message,
            replyMarkup,
            extraOptions
          ),
        sheets
      })).catch((error) => {
        logBotError("[Admin] Clear protections error (unhandled).", { error: error.message });
      });
      return;
    }

    if (action.startsWith("confirm:promptall:")) {
      const interactionId = action.split(":")[2];
      const resolved = getInteraction(ctx, interactionId, "prompt-all", "confirm");
      if (!resolved || !consumeInteraction(ctx, interactionId, "prompt-all")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      await runAdminAction("promptall:execute", ctx, bot, sheets, config, adminCache);
      return;
    }

    if (action.startsWith("pick:code:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      const [, , interactionId, choiceId] = action.split(":");
      const resolved = getInteraction(ctx, interactionId, "admin-code", choiceId);
      const picked = resolved?.choice;

      if (!picked) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const invite = await getOnboardingInvite(picked.appointment, {
        expectedStateIdentity: picked.expectedStateIdentity
      });
      if (!invite.ok) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      await sendOrUpdateAdminMessage(
        ctx,
        buildInviteMessage(invite, bot, { html: true }),
        buildInviteReplyMarkup(invite, bot, "admin:menu:codes:0"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (action.startsWith("pick:invite:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      const [, , interactionId, choiceId] = action.split(":");
      const resolved = getInteraction(ctx, interactionId, "admin-invite", choiceId);
      const picked = resolved?.choice;

      if (!picked) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      const invite = await getOnboardingInvite(picked.appointment, {
        expectedStateIdentity: picked.expectedStateIdentity
      });
      if (!invite.ok) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      await sendOrUpdateAdminMessage(
        ctx,
        buildInviteMessage(invite, bot, { html: true }),
        buildInviteReplyMarkup(invite, bot, "admin:menu:invite:0"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (action.startsWith("pick:addadmin:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      const [, , interactionId, choiceId] = action.split(":");
      const resolved = getInteraction(ctx, interactionId, "admin-add-admin", choiceId);
      const picked = resolved?.choice;

      if (!picked) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      if (!consumeInteraction(ctx, interactionId, "admin-add-admin")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const confirmation = beginInteraction(ctx, "admin-add-admin-confirm", { confirm: picked }, { ttlMs: 2 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        picked.boundFullName
          ? `Grant admin access to ${picked.appointment} (${picked.boundFullName})?`
          : `Grant admin access to ${picked.appointment}?`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Grant Admin", `admin:confirm:addadmin:${confirmation.id}`),
            Markup.button.callback("↩️ Cancel", "admin:menu:admins"),
            Markup.button.callback("❌ Close", "admin:close")
          ]
        ])
      );
      return;
    }

    if (action.startsWith("pick:deregister:")) {
      const [, , interactionId, choiceId] = action.split(":");
      const resolved = getInteraction(ctx, interactionId, "admin-deregister", choiceId);
      const picked = resolved?.choice;

      if (!picked) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      if (!consumeInteraction(ctx, interactionId, "admin-deregister")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const confirmation = beginInteraction(ctx, "admin-deregister-confirm", { confirm: picked }, { ttlMs: 2 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        `Deregister ${picked.appointment}${picked.boundFullName ? ` (${picked.boundFullName})` : ""}? Their Telegram binding will be removed and their registration code rotated.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Deregister", `admin:confirm:deregister:${confirmation.id}`),
            Markup.button.callback("↩️ Cancel", "admin:menu:deregister:0"),
            Markup.button.callback("❌ Close", "admin:close")
          ]
        ])
      );
      return;
    }

    if (action.startsWith("pick:transferfrom:")) {
      // Admin selected the "from" user — now show the "to" slot list.
      const [, , fromIdxRaw, fromFingerprint] = action.split(":");
      const fromIdx = Number(fromIdxRaw);
      const from = resolveFingerprintedSelection(
        adminCache.transferFromCandidates,
        fromIdx,
        fromFingerprint,
        "bindingIdentity"
      );
      if (!from) {
        await renderTransferFromSubmenu(ctx, adminCache, 0);
        return;
      }
      await renderTransferToSubmenu(
        ctx,
        adminCache,
        fromIdx,
        fromFingerprint,
        0
      );
      return;
    }

    if (action.startsWith("pick:transferto:")) {
      // Format: pick:transferto:<fromIdx>:<fromFingerprint>:<toIdx>:<toFingerprint>
      const parts = action.split(":");
      const fromIdx = Number(parts[2]);
      const fromFingerprint = parts[3];
      const toIdx = Number(parts[4]);
      const toFingerprint = parts[5];
      const from = resolveFingerprintedSelection(
        adminCache.transferFromCandidates,
        fromIdx,
        fromFingerprint,
        "bindingIdentity"
      );
      const to = resolveFingerprintedSelection(
        adminCache.transferToCandidates,
        toIdx,
        toFingerprint
      );

      if (!from || !to) {
        await renderTransferFromSubmenu(ctx, adminCache, 0);
        return;
      }

      // Validate the binding and create the recovery journal inside the same
      // storage-serialized preparation step. A stale callback therefore cannot
      // leave a prepared journal behind before its binding is proven current.
      let transferJournal;
      let remoteMutationOccurred = false;
      let result;
      try {
        result = await transferAppointmentBinding(
        from.appointment,
        to.appointment,
        {
          expectedFromBindingIdentity: from.bindingIdentity,
          prepare: async ({ fromAppointment, toAppointment, bindingIdentity }) => {
            try {
              transferJournal = await beginAttendanceTransferJournal(
                fromAppointment,
                toAppointment,
                { expectedFromBindingIdentity: bindingIdentity }
              );
            } catch (error) {
              logBotWarn("Rejected transfer while recovery journal is retained.", {
                fromAppointment,
                toAppointment,
                error: error.message
              });
              return { ok: false, reason: "attendance_transfer_recovery_required" };
            }
            const attendanceResults = await transferAttendanceRows(
              sheets,
              config,
              fromAppointment,
              toAppointment,
              { phase: "copy" }
            );

            if (isAttendanceTransferBlocked(attendanceResults)) {
              return {
                ok: false,
                reason: "attendance_transfer_blocked",
                attendanceResults
              };
            }
            remoteMutationOccurred = attendanceResults.some((entry) => entry.transferred);
            await updateAttendanceTransferJournal(transferJournal.id, "copied", {
              copiedSheets: attendanceResults.filter((entry) => entry.transferred).map((entry) => entry.title)
            });
            return { ok: true, attendanceResults };
          }
        }
        );
      } catch (error) {
        logBotError("Attendance transfer interrupted; recovery journal retained.", {
          fromAppointment: from.appointment,
          toAppointment: to.appointment,
          error: error.message
        });
        throw error;
      }

      if (result.ok) {
        await updateAttendanceTransferJournal(transferJournal.id, "binding_committed");
        const cleanup = await completeAttendanceTransferCleanup({
          journal: transferJournal,
          sheets,
          config
        });
        if (!cleanup.cleaned) {
          logBotError("Attendance transfer binding committed but source cleanup is blocked; journal retained.", {
            fromAppointment: result.fromAppointment,
            toAppointment: result.toAppointment,
            attendanceResults: cleanup.attendanceResults
          });
          await sendOrUpdateAdminMessage(
            ctx,
            `⚠️ Transferred <b>${result.fromAppointment}</b> → <b>${result.toAppointment}</b>, but source attendance cleanup is blocked. Recovery is required; the transfer journal has been retained.`,
            Markup.inlineKeyboard([[
              Markup.button.callback("🔙 Back", "admin:menu:roster")
            ], [
              Markup.button.callback("❌ Close", "admin:close")
            ]]),
            { parse_mode: "HTML" }
          );
          await refreshAdminCache(adminCache, config);
          return;
        }
        const sheetsMoved = cleanup.attendanceResults.filter((r) => r.transferred).map((r) => r.title);
        const attendanceNote = sheetsMoved.length > 0
          ? `\nAttendance carried over from: ${sheetsMoved.join(", ")}.`
          : "";

        await sendOrUpdateAdminMessage(
          ctx,
          `✅ Transferred <b>${result.fromAppointment}</b> → <b>${result.toAppointment}</b>.\n${result.fullName ? `User: ${result.fullName}` : ""}${attendanceNote}\n\nRun <b>Sync Roster</b> to reorder the attendance sheet rows.`,
          Markup.inlineKeyboard([[
            Markup.button.callback("🔄 Sync Roster", "admin:syncroster"),
            Markup.button.callback("🔙 Back", "admin:menu:roster")
          ], [
            Markup.button.callback("❌ Close", "admin:close")
          ]]),
          { parse_mode: "HTML" }
        );
      } else {
        // Only this invocation's untouched prepared journal is safe to remove.
        // A copied or committed journal may represent a crash after a remote
        // Sheets mutation and must remain available for recovery.
        if (transferJournal && !remoteMutationOccurred) {
          await clearAttendanceTransferJournal(transferJournal.id);
        }
        const message = result.reason === "attendance_transfer_blocked"
          ? formatAttendanceTransferBlockedMessage(
              result.preparation?.attendanceResults ?? [],
              to.appointment
            )
          : formatAppointmentTransferFailure(result, to.appointment);
        await sendOrUpdateAdminMessage(
          ctx,
          message,
          Markup.inlineKeyboard([[
            Markup.button.callback("🔙 Back", "admin:menu:roster")
          ], [
            Markup.button.callback("❌ Close", "admin:close")
          ]])
        );
      }

      await refreshAdminCache(adminCache, config);
      return;
    }

    if (action.startsWith("pick:appointmentremove:")) {
      const [, , interactionId, choiceId] = action.split(":");
      const resolved = getInteraction(ctx, interactionId, "admin-remove-appointment", choiceId);
      const picked = resolved?.choice;

      if (!picked) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      if (!consumeInteraction(ctx, interactionId, "admin-remove-appointment")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const confirmation = beginInteraction(ctx, "admin-remove-appointment-confirm", { confirm: picked }, { ttlMs: 2 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        picked.boundChatId
          ? `Remove ${picked.appointment}${picked.boundFullName ? ` (${picked.boundFullName})` : ""} from the active roster? Their current Telegram binding will also be removed.`
          : `Remove ${picked.appointment} from the active roster? This cannot be undone from Telegram.`,
        Markup.inlineKeyboard([[
          Markup.button.callback("✅ Remove Appointment", `admin:confirm:appointmentremove:${confirmation.id}`),
          Markup.button.callback("↩️ Cancel", "admin:menu:roster")
        ], [Markup.button.callback("❌ Close", "admin:close")]])
      );
      return;
    }

    if (action.startsWith("pick:removeadmin:")) {
      const [, , interactionId, choiceId] = action.split(":");
      const resolved = getInteraction(ctx, interactionId, "admin-remove-admin", choiceId);
      const picked = resolved?.choice;

      if (!picked) {
        await rejectExpiredInteraction(ctx);
        return;
      }

      if (!consumeInteraction(ctx, interactionId, "admin-remove-admin")) {
        await rejectExpiredInteraction(ctx);
        return;
      }
      const confirmation = beginInteraction(
        ctx,
        "admin-remove-admin-confirm",
        { confirm: picked },
        { ttlMs: 2 * 60 * 1000 }
      );
      await sendOrUpdateAdminMessage(
        ctx,
        `Remove custom admin access from ${picked.appointment}${picked.boundFullName ? ` (${picked.boundFullName})` : ""}?`,
        Markup.inlineKeyboard([[
          Markup.button.callback("✅ Remove Admin", `admin:confirm:removeadmin:${confirmation.id}`),
          Markup.button.callback("↩️ Cancel", "admin:menu:admins"),
          Markup.button.callback("❌ Close", "admin:close")
        ]])
      );
      return;
    }

    if (action.startsWith("pick:optionremove:")) {
      const [, , indexRaw, fingerprint] = action.split(":");
      const option = resolveFingerprintedSelection(
        config.attendanceOptions.map((entry) => ({ option: entry })),
        indexRaw,
        fingerprint,
        "option"
      )?.option;

      if (!option) {
        await renderAttendanceOptionRemovalMenu(ctx, config, 0);
        return;
      }

      if (config.attendanceOptions.length === 1) {
        await sendOrUpdateAdminMessage(
          ctx,
          "At least one attendance option must remain configured.",
          buildAttendanceOptionsMenu()
        );
        return;
      }
      const confirmation = beginInteraction(ctx, "attendance-option-remove", {
        confirm: { option, expectedOptions: [...config.attendanceOptions] }
      }, { ttlMs: 2 * 60 * 1000 });
      await sendOrUpdateAdminMessage(
        ctx,
        `Remove attendance option ${option}? Existing sheet values will be preserved, but it will disappear from future menus.`,
        Markup.inlineKeyboard([[
          Markup.button.callback("✅ Remove Option", `admin:confirm:optionremove:${confirmation.id}`),
          Markup.button.callback("↩️ Cancel", "admin:menu:options")
        ]])
      );
      return;
    }

    await runAdminAction(action, ctx, bot, sheets, config, adminCache);
  });

  registerBackgroundSchedules({ bot, sheets, config, adminCache });

  return bot;
}

export const __testing = {
  buildAdminMenuDescription,
  buildAttendanceOptionsDescription,
  buildHomeMenu,
  buildDepartmentWorkweekViewModel,
  buildInvitationAdminDescription,
  buildInviteMessage,
  buildManageAdminsDescription,
  buildHomeMenuText,
  buildDatedAttendanceMenu,
  getAttendanceOptionGroups,
  buildAttendanceGroupMenu,
  buildAttendanceGroupOptionMenu,
  buildDailyAttendanceIdempotencyKey,
  buildWeeklyAttendanceIdempotencyKey,
  rejectExpiredInteraction,
  addManagedAppointment,
  removeManagedAppointment,
  applyAttendanceOptionChange,
  formatAppointmentTransferFailure,
  formatAttendanceTransferBlockedMessage,
  isAttendanceTransferBlocked,
  isAttendanceTransferCleanupBlocked,
  isPrivateTelegramIdentity,
  appendAttendancePromptMessageId,
  formatDepartmentViewMessage,
  buildSummaryMenu,
  formatSummaryMessage,
  formatHomeSynchronizationTimestamp,
  getCanonicalAttendanceOptions,
  getDepartmentKeyForAppointment,
  getLatestHomeSynchronizationTimestamp,
  getWeeklyAttendanceState,
  handleInviteCommand,
  handleOnboardCommand,
  handleOptionsResetAction,
  handleFlushAttendanceAdminAction,
  handleQueueStatusAdminAction,
  handleSyncRosterAdminAction,
  withSheetOperation,
  triggerAttendanceQueueThresholdFlush,
  triggerBackgroundSheetRefresh,
  renderInviteSubmenu,
  renderAttendanceOptionsMenu,
  removeObsoleteAttendancePromptMessages,
  restoreWeeklyAttendanceSession,
  registerBackgroundSchedules,
  completeAttendanceTransferCleanup,
  recoverAttendanceTransferJournal,
  resetRosterSyncGuard() { rosterSyncInProgress = false; },
  detectSnapshotDivergences,
  snapshotAppointmentHasData,
  runSelfHealingCycle,
  resetSelfHealGuard() { lastSelfHealAt = 0; },
  selfHealLog,
  buildSelfHealLogsText,
  buildSelfHealLogsMenu,
  allSettledConcurrent,
  TELEGRAM_SEND_INTERVAL_MS,
  TELEGRAM_SEND_CONCURRENCY
};
