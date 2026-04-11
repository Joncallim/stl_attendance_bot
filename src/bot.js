import cron from "node-cron";
import { Markup, Telegraf, session } from "telegraf";
import { ipv4HttpsAgent } from "./network.js";
import {
  applyAttendanceEntriesToSnapshotBundle,
  addAppointmentToSheets,
  buildQueuedAttendanceEventMetadata,
  classifyAppointmentDepartment,
  createGoogleSheetsClient,
  DEPARTMENT_BUCKETS,
  ensureNextMonthSheetExists,
  getLastStructuralMaintenanceAt,
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
  writeAttendanceStatuses
} from "./googleSheets.js";
import {
  compactAttendanceQueue,
  enqueueAttendanceEvent,
  enqueueAttendanceEvents,
  getAttendanceQueueStatus,
  listPendingAttendanceEvents,
  flushAttendanceQueue
} from "./attendanceQueue.js";
import { getSingaporePublicHolidaySet } from "./holidays.js";
import {
  addAdminAppointment,
  addAppointmentToRegistry,
  bindAppointmentCode,
  deregisterAppointmentBinding,
  deregisterRequestorByChatId,
  getAppointmentRegistry,
  getSettings,
  getUserByChatId,
  getOnboardingInvite,
  listAdminAppointments,
  listUsers,
  removeAppointmentFromRegistry,
  resetAttendanceOptions,
  removeAdminAppointment,
  setAttendanceOptionUsage,
  setAttendanceOptions,
  syncAppointmentRegistry,
  updateUserByChatId,
  upsertUser
} from "./storage.js";
import { createSyncManager } from "./syncManager.js";
import { runSerialized } from "./fileStore.js";
import {
  applyWeeklyAttendanceSelection,
  createWeeklyFlowState,
  getStagedAttendanceStatus,
  upsertWeeklyAttendanceEntry
} from "./weeklyFlow.js";

const ONBOARDING_CODE_PROMPT = "Send the secret code assigned to your appointment.";
const BOT_VERSION = "v0.9.2";

const WEEK_SKIP_LABEL = "Skip Day";
const SHEET_OPERATION_MUTEX_KEY = "sheet-operations";
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
  "PCL",
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
  PCL: "Parent Care Leave",
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
      Markup.button.callback("🔙 Back", "home:main")
    ],
    [
      Markup.button.callback("❌ Close", "admin:close")
    ],
  ]);
}

function buildAdminRosterMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🕓 Pending", "admin:pending")],
    [
      Markup.button.callback("➕ Add Appointment", "admin:appointments:add"),
      Markup.button.callback("➖ Remove Appointment", "admin:menu:appointments:remove:0")
    ],
    [Markup.button.callback("🔄 Sync Roster", "admin:syncroster")],
    [
      Markup.button.callback("🔙 Back", "admin:main"),
      Markup.button.callback("❌", "admin:close")
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
    Markup.button.callback("❓ Help", "home:help"),
    Markup.button.callback("❌ Close", "home:close")
  );

  const rows = [];

  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }

  return Markup.inlineKeyboard(rows);
}

function buildSelfDeregisterMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Yes, Deregister Me", "home:deregister:confirm")],
    [
      Markup.button.callback("🔙 Back", "home:main"),
      Markup.button.callback("❌", "home:close")
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
    Markup.button.callback("Next Day ➡️", `${namespace}:summary:${nextDate}`)
  ]];

  if (options.includeUnaccounted !== false) {
    rows.push([
      Markup.button.callback("🕳️ Unaccounted", `${namespace}:summary:unaccounted:${toIsoDateString(date, timezone)}`)
    ]);
  }

  rows.push(
    [
      Markup.button.callback("🔙 Back", backTarget),
      Markup.button.callback("❌", `${namespace}:close`)
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
      Markup.button.callback("❌", "admin:close")
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
      Markup.button.callback("❌", "admin:close")
    ]
  ]);
}

function buildAppointmentManagementBackMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔙 Back", "admin:menu:roster"),
      Markup.button.callback("❌", "admin:close")
    ]
  ]);
}

function buildUnaccountedMenu(date, timezone, rows, backTarget, namespace) {
  return Markup.inlineKeyboard([
    ...rows,
    [Markup.button.callback("🔙 Back", `${namespace}:summary:${toIsoDateString(date, timezone)}`)],
    [Markup.button.callback("❌", `${namespace}:close`)]
  ]);
}

function buildPagedSelectionMenu(items, page, itemPrefix, pageCallbackPrefix, backTarget) {
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const startIndex = safePage * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);
  const rows = [];

  for (let index = 0; index < pageItems.length; index += 4) {
    rows.push(
      pageItems.slice(index, index + 4).map((item, offset) =>
        Markup.button.callback(item.label, `${itemPrefix}:${startIndex + index + offset}`)
      )
    );
  }

  const navRow = [];

  if (safePage > 0) {
    navRow.push(
      Markup.button.callback("⬅️ Prev", `${pageCallbackPrefix}:${safePage - 1}`)
    );
  }

  if (safePage < totalPages - 1) {
    navRow.push(
      Markup.button.callback("Next ➡️", `${pageCallbackPrefix}:${safePage + 1}`)
    );
  }

  navRow.push(Markup.button.callback("❌", "admin:close"));
  rows.push(navRow);
  rows.push([Markup.button.callback("🔙 Back", backTarget)]);

  return Markup.inlineKeyboard(rows);
}

function buildInlineAttendanceMenu(
  options,
  page,
  itemPrefix,
  pagePrefix,
  backTarget,
  extraRows = []
) {
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(options.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const startIndex = safePage * pageSize;
  const pageItems = options.slice(startIndex, startIndex + pageSize);
  const rows = [...extraRows];

  for (let index = 0; index < pageItems.length; index += 4) {
    rows.push(
      pageItems.slice(index, index + 4).map((option, offset) =>
        Markup.button.callback(option, `${itemPrefix}:${startIndex + index + offset}`)
      )
    );
  }

  const navRow = [];

  if (safePage > 0) {
    navRow.push(Markup.button.callback("⬅️ Prev", `${pagePrefix}:${safePage - 1}`));
  }

  if (safePage < totalPages - 1) {
    navRow.push(Markup.button.callback("Next ➡️", `${pagePrefix}:${safePage + 1}`));
  }

  navRow.push(Markup.button.callback("❌ Close", "home:close"));
  rows.push(navRow);
  rows.push([Markup.button.callback("🔙 Back", backTarget)]);

  return Markup.inlineKeyboard(rows);
}

function formatUserName(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
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
    try {
      await ctx.editMessageText(text, messageOptions);
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

    return;
  }

  await ctx.reply(text, messageOptions);
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
      { text: "❌", callback_data: "admin:close" }
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

  const appointmentIndex = snapshot.appointments.findIndex(
    (value) => value.toUpperCase() === appointment.toUpperCase()
  );

  if (appointmentIndex === -1) {
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
          `home:department:edit:${viewModel.departmentKey}:${viewModel.weekOffset}:${viewModel.page}:${member.absoluteIndex}:${dayIndex}`
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
    Markup.button.callback("❌", "home:close")
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
    Markup.button.callback("❌", "home:close")
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
  const descriptions = [
    "📝 Today's Attendance: Submit or update your attendance for today.",
    ...getHomeWeekDescriptions(timezone),
    "🏢 My Department: View and edit your department's workweek attendance.",
    "⚠️ Deregister: Remove your Telegram binding and rotate your code.",
    "📊 Summary: View the attendance summary for the selected day.",
    "❓ Help: Show the command and usage guide.",
    "❌ Close: Close this menu."
  ];

  if (isAdminUser) {
    descriptions.splice(
      2,
      0,
      "🛠️ Admin Menu: Manage roster sync, invitations, admins, prompts, and deregistration."
    );
  }

  const lines = [
    `${greeting}, ${name}. Today is ${todayLabel}.`,
    "",
    "Choose an action below:",
    "",
    ...descriptions
  ];

  if (isAdminUser) {
    const latestSynchronizationAt = getLatestHomeSynchronizationTimestamp(syncStatus);
    lines.push(
      "",
      "---",
      "",
      `Last Synchronisation: ${formatHomeSynchronizationTimestamp(latestSynchronizationAt, timezone)}`
    );
  }

  return lines.join("\n");
}

function buildAdminMenuDescription() {
  return [
    `Admin Menu (${BOT_VERSION})`,
    "",
    "Use this menu to manage roster operations and onboarding support.",
    "",
    "📋 Roster: View onboarding gaps and run a manual roster sync.",
    "✉️ Send Invitation: Generate and forward an invitation for personnel who have not onboarded.",
    "👮 Manage Admins: Review current admins and add or remove admin appointments.",
    "📣 Prompt All: Send the attendance prompt to all currently bound users.",
    "🧩 Attendance Options: View, add, remove, or reset the allowed attendance codes.",
    "🧾 Deregister Person: Remove another person’s Telegram binding and rotate their code.",
    "🔙 Back: Return to the main home menu."
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
    "These codes appear in Telegram and in the Google Sheets dropdown validation.",
    "The default list comes from settings.yaml, and Telegram changes are saved in local storage.",
    ""
  ];

  if (attendanceOptions.length === 0) {
    lines.push("No attendance options are currently configured.");
  } else if (Array.isArray(attendanceGroups) && attendanceGroups.length > 0) {
    lines.push(`Current options (${attendanceOptions.length}):`);

    for (const group of attendanceGroups) {
      const visibleOptions = group.options.filter((option) => attendanceOptions.includes(option));

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
  lines.push("Use the buttons below to add, remove, or reset the list back to the Onboarding defaults.");
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
  const visibleRows = [
    ...defaultRows,
    ...customRows.filter((entry) => !adminByAppointment.has(entry.appointment.toUpperCase()) || entry.source === "custom")
  ];

  if (visibleRows.length === 0) {
    lines.push("None");
  } else {
    lines.push(...visibleRows.map((entry) => {
      const onboardingStatus = entry.onboarded ? "onboarded" : "not onboarded";
      return `• ${entry.appointment} (${entry.source}, ${onboardingStatus})`;
    }));
  }

  lines.push("");
  lines.push("Choose whether to add or remove admin appointments below.");
  return lines.join("\n");
}

function buildRosterDescription() {
  return [
    "Roster Menu",
    "",
    "Use this section to manage the onboarding roster.",
    "🕓 Pending shows active personnel who have not onboarded yet.",
    "➕ Add Appointment inserts a new appointment into the managed roster and generates a fresh onboarding code.",
    "➖ Remove Appointment removes a managed appointment from the active roster and clears any existing binding.",
    "🔄 Sync Roster refreshes the ONBOARDING sheet, secret codes, and monthly attendance sheets."
  ].join("\n");
}

function buildInvitationAdminDescription(pendingCount) {
  return [
    "Send Invitation",
    "",
    pendingCount === 1
      ? "1 person is currently not onboarded."
      : `${pendingCount} people are currently not onboarded.`,
    "Select a person to generate and send a forwardable invitation message."
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
    ? config.attendanceGroups.map((group) => ({
      heading: group.summaryLabel ?? group.label,
      total: group.options.reduce(
        (sum, option) => sum + Number(rawCounts.get(option) ?? 0),
        0
      ),
      breakdown: buildBreakdown(group.options)
    }))
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
        breakdown: buildBreakdown(["LL", "CCL", "PCL", "CSL", "COMPASSIONATE", "PTL"])
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

    lines.push(...section.breakdown.map((entry) => `${entry.status}: ${entry.count}`));
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
    removeAdminCandidates: []
  };
}

function withSheetOperation(operation) {
  return runSerialized(SHEET_OPERATION_MUTEX_KEY, operation);
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
  await updateUserByChatId(ctx.chat.id, {
    awaitingWeeklyAttendance: false,
    weeklyAttendanceDates: [],
    weeklyAttendanceIndex: 0,
    weeklyAttendanceResults: [],
    weeklyAttendanceEntries: []
  });
}

async function finalizeWeeklyAttendanceFlow(ctx, config, appointment, cache) {
  const results = Array.isArray(ctx.session.weeklyAttendanceResults)
    ? ctx.session.weeklyAttendanceResults
    : [];
  const entries = Array.isArray(ctx.session.weeklyAttendanceEntries)
    ? ctx.session.weeklyAttendanceEntries
    : [];

  if (entries.length > 0) {
    const queuedEntries = entries.map((entry) => ({
      appointment,
      status: entry.status,
      date: new Date(entry.date),
      source: "weekly",
      ...buildQueuedAttendanceEventMetadata(cache.sheetSnapshots, config, {
        appointment,
        status: entry.status,
        date: new Date(entry.date)
      })
    }));
    await enqueueAttendanceEvents(
      config,
      queuedEntries
    );

    if (cache.sheetSnapshots) {
      cache.sheetSnapshots = applyAttendanceEntriesToSnapshotBundle(
        cache.sheetSnapshots,
        config,
        queuedEntries
      );
      cache.summaryMemo.clear();
      cache.summaryMemoVersion = cache.sheetSnapshots?.synchronizedAt ?? null;
    }
  }

  await clearWeeklyAttendanceState(ctx);
  const weeklyHeader = entries.length > 0
    ? "Weekly attendance updated and queued for Google Sheets sync:"
    : "Weekly attendance reviewed. No new entries were submitted.";
  await sendOrUpdateAdminMessage(
    ctx,
    [weeklyHeader, "", ...results].join("\n"),
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🔙 Back", "home:main"),
        Markup.button.callback("❌ Close", "home:close")
      ]
    ])
  );
}

async function resetConversationState(ctx) {
  ctx.session.awaitingAttendance = false;
  ctx.session.awaitingSecretCode = false;
  ctx.session.awaitingAttendanceOptionAdd = false;
  ctx.session.awaitingAppointmentAdd = false;
  await clearWeeklyAttendanceState(ctx);
  await updateUserByChatId(ctx.chat.id, {
    awaitingAttendance: false,
    awaitingSecretCode: false
  });
}

async function askForSecretCode(ctx, config) {
  await clearWeeklyAttendanceState(ctx);
  ctx.session.awaitingSecretCode = true;
  await updateUserByChatId(ctx.chat.id, {
    awaitingSecretCode: true
  });
  await ctx.reply(ONBOARDING_CODE_PROMPT, Markup.removeKeyboard());
}

async function askAttendance(ctx, config, user = null, cache = null) {
  ctx.session.awaitingAttendance = true;
  ctx.session.awaitingWeeklyAttendance = false;
  ctx.session.weeklyAttendanceDates = [];
  ctx.session.weeklyAttendanceIndex = 0;
  ctx.session.weeklyAttendanceResults = [];
  ctx.session.weeklyAttendanceEntries = [];
  await updateUserByChatId(ctx.chat.id, {
    awaitingAttendance: true,
    awaitingWeeklyAttendance: false,
    weeklyAttendanceDates: [],
    weeklyAttendanceIndex: 0,
    weeklyAttendanceResults: [],
    weeklyAttendanceEntries: [],
    promptedAt: new Date().toISOString()
  });
  const date = new Date();
  const message = buildTodayAttendancePromptMessage(
    config,
    date,
    user?.appointment ?? null,
    cache
  );
  await sendOrUpdateAdminMessage(
    ctx,
    message,
    buildInlineAttendanceMenu(
      config.attendanceOptions,
      0,
      "home:pick:attendance",
      "home:attendance:page",
      "home:main"
    )
  );
}

async function promptWeeklyAttendanceDay(ctx, config, user, cache, page = 0) {
  const dateValue = ctx.session.weeklyAttendanceDates?.[ctx.session.weeklyAttendanceIndex];

  if (!dateValue) {
    return;
  }

  const date = new Date(dateValue);
  const label = formatAttendanceDateLabel(date, config.timezone);
  const stagedStatus = getStagedAttendanceStatus(
    ctx.session.weeklyAttendanceEntries ?? [],
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
    "Public holidays are prefilled as PH. Use Skip Day to keep the current entry unchanged.",
    "",
    detailLine
  ].join("\n");
  await sendOrUpdateAdminMessage(
    ctx,
    message,
    buildInlineAttendanceMenu(
      config.attendanceOptions,
      page,
      "home:pick:week",
      "home:week:page",
      "home:main",
      [[Markup.button.callback(WEEK_SKIP_LABEL, "home:pick:week:skip")]]
    )
  );
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
  const weeklyState = createWeeklyFlowState(getWorkweekDates(config.timezone, weekOffset));

  ctx.session.awaitingAttendance = false;
  ctx.session.awaitingWeeklyAttendance = weeklyState.awaitingWeeklyAttendance;
  ctx.session.weeklyAttendanceDates = weeklyState.weeklyAttendanceDates;
  ctx.session.weeklyAttendanceIndex = weeklyState.weeklyAttendanceIndex;
  ctx.session.weeklyAttendanceResults = weeklyState.weeklyAttendanceResults;
  ctx.session.weeklyAttendanceEntries = weeklyState.weeklyAttendanceEntries;

  await updateUserByChatId(ctx.chat.id, {
    awaitingAttendance: false,
    ...weeklyState
  });

  await autoFillWeeklyPublicHolidays(ctx, config, sheets, user, cache);

  await promptWeeklyAttendanceDay(ctx, config, user, cache);
}

async function registerUser(ctx) {
  const from = ctx.from;

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

async function isAdmin(ctx, config) {
  const user = await getUserByChatId(ctx.chat.id);

  if (!user?.appointment) {
    return false;
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
          Markup.button.callback("❌", "home:close")
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

async function queueAttendanceSelection(cache, config, appointment, status, date, source) {
  const queuedEntry = {
    appointment,
    status,
    date,
    source,
    ...buildQueuedAttendanceEventMetadata(cache.sheetSnapshots, config, {
      appointment,
      status,
      date
    })
  };

  await enqueueAttendanceEvent(config, queuedEntry);

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

async function syncRosterState(sheets, config) {
  const roster = await syncOnboardingRoster(sheets, config);

  if (roster.driftDetected) {
    return roster;
  }

  const registry = await syncAppointmentRegistry(roster.onboardingAppointments);
  await syncOnboardingCodeColumn(
    sheets,
    config,
    registry.appointments.filter((entry) => entry.active)
  );
  return roster;
}

async function preloadSheetSnapshots(sheets, config, cache, options = {}) {
  const snapshotBundle = await preloadAttendanceSnapshots(sheets, config, options);
  const pendingEvents = await listPendingAttendanceEvents();
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
  const adminSet = new Set(admins.map((entry) => entry.appointment.toUpperCase()));
  const activeCodes = registry.appointments.filter((entry) => entry.active);
  const pending = activeCodes.filter((entry) => !entry.boundChatId);

  cache.activeCodes = activeCodes;
  cache.pending = pending;
  cache.admins = admins;
  cache.inviteCandidates = pending.map((entry) => ({
    label: entry.appointment,
    appointment: entry.appointment
  }));
  cache.deregisterCandidates = activeCodes
    .filter((entry) => entry.boundChatId)
    .map((entry) => ({ label: entry.appointment, appointment: entry.appointment }));
  cache.removeAppointmentCandidates = activeCodes.map((entry) => ({
    label: entry.appointment,
    appointment: entry.appointment
  }));
  cache.addAdminCandidates = activeCodes
    .filter((entry) => !adminSet.has(entry.appointment.toUpperCase()))
    .map((entry) => ({ label: entry.appointment, appointment: entry.appointment }));
  cache.removeAdminCandidates = admins
    .filter((entry) => entry.source === "custom")
    .map((entry) => ({ label: entry.appointment, appointment: entry.appointment }));

  cache.inviteCandidates = sortAppointmentsForAdmin(cache.inviteCandidates, config);
  cache.removeAppointmentCandidates = sortAppointmentsForAdmin(cache.removeAppointmentCandidates, config);
  cache.addAdminCandidates = sortAppointmentsForAdmin(cache.addAdminCandidates, config);
  cache.removeAdminCandidates = sortAppointmentsForAdmin(cache.removeAdminCandidates, config);
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
      cache.syncManager.runCycle({ force: false, reason: "background" }).catch((error) => {
        console.error("Background sync refresh failed:", error);
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

  syncManager.runCycle({ force: false, reason }).catch((error) => {
    console.error("Background sync refresh failed:", error);
  });
  return true;
}

async function applyAttendanceOptionChange(sheets, config, cache, nextOptions) {
  await withSheetOperation(async () => {
    config.attendanceOptions = nextOptions;
    await setAttendanceOptions(nextOptions);
    await syncRosterState(sheets, config);
    await ensureNextMonthSheetExists(sheets, config);
    await refreshAdminCache(cache, config);
    await preloadSheetSnapshots(sheets, config, cache, { force: true });
  });
}

async function addManagedAppointment(sheets, config, cache, appointment) {
  return withSheetOperation(async () => {
    const registryResult = await addAppointmentToRegistry(appointment);

    if (!registryResult.ok) {
      return registryResult;
    }

    await addAppointmentToSheets(sheets, config, registryResult.appointment);
    await syncOnboardingCodeColumn(
      sheets,
      config,
      (await getAppointmentRegistry()).appointments.filter((entry) => entry.active)
    );
    await refreshAdminCache(cache, config);
    await preloadSheetSnapshots(sheets, config, cache, { force: true });
    return registryResult;
  });
}

async function removeManagedAppointment(sheets, config, cache, appointment) {
  return withSheetOperation(async () => {
    const registryResult = await removeAppointmentFromRegistry(appointment);

    if (!registryResult.ok) {
      return registryResult;
    }

    await removeAppointmentFromSheets(sheets, config, registryResult.appointment);
    await syncOnboardingCodeColumn(
      sheets,
      config,
      (await getAppointmentRegistry()).appointments.filter((entry) => entry.active)
    );
    await refreshAdminCache(cache, config);
    await preloadSheetSnapshots(sheets, config, cache, { force: true });
    return registryResult;
  });
}

function sortAttendanceOptionsByUsage(attendanceOptions, usageMap = {}) {
  return [...attendanceOptions].sort((left, right) => {
    const leftUsage = Number(usageMap[left] ?? 0);
    const rightUsage = Number(usageMap[right] ?? 0);

    if (rightUsage !== leftUsage) {
      return rightUsage - leftUsage;
    }

    return left.localeCompare(right);
  });
}

async function refreshAttendanceOptionUsage(sheets, config, cache) {
  const usageMap = await summarizeAttendanceOptionUsage(sheets, config);

  await setAttendanceOptionUsage(usageMap);

  return config.attendanceOptions;
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
          Markup.button.callback("❌", "admin:close")
        ]
      ])
    );
    return;
  }

  const items = pending.map((entry) => ({
    label: entry.appointment,
    appointment: entry.appointment
  }));

  await sendOrUpdateAdminMessage(
    ctx,
    buildInvitationAdminDescription(pending.length),
    buildPagedSelectionMenu(
      items,
      0,
      "admin:pick:code",
      "admin:menu:codes",
      "admin:main"
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
    appointment: entry.appointment
  }));

  await sendOrUpdateAdminMessage(
    ctx,
    "Select a person to generate and send a forwardable invitation message.",
    buildPagedSelectionMenu(
      items,
      page,
      "admin:pick:code",
      "admin:menu:codes",
      "admin:main"
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
          Markup.button.callback("❌", "admin:close")
        ]
      ])
    );
    return;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    "Select an appointment to add as admin.",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:addadmin",
      "admin:menu:addadmin",
      "admin:menu:admins"
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
          Markup.button.callback("❌", "admin:close")
        ]
      ])
    );
    return;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    "Select a custom admin to remove.",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:removeadmin",
      "admin:menu:removeadmin",
      "admin:menu:admins"
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
          Markup.button.callback("❌", "admin:close")
        ]
      ])
    );
    return;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    buildInvitationAdminDescription(candidates.length),
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:invite",
      "admin:menu:invite",
      "admin:main"
    )
  );
}

async function renderDeregisterSubmenu(ctx, cache, page = 0) {
  const candidates = cache.deregisterCandidates;

  if (candidates.length === 0) {
    await sendOrUpdateAdminMessage(
      ctx,
      "There are no onboarded personnel to deregister.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔙 Back", "admin:main"),
          Markup.button.callback("❌", "admin:close")
        ]
      ])
    );
    return;
  }

  await sendOrUpdateAdminMessage(
    ctx,
    "Select a person to deregister.",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:deregister",
      "admin:menu:deregister",
      "admin:main"
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

  await sendOrUpdateAdminMessage(
    ctx,
    "Select an appointment to remove from the active roster.",
    buildPagedSelectionMenu(
      candidates,
      page,
      "admin:pick:appointmentremove",
      "admin:menu:appointments:remove",
      "admin:menu:roster"
    )
  );
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
      "admin:menu:options"
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
    await handleSyncRosterAdminAction(ctx, config, {
      syncRosterState,
      ensureNextMonthSheetExists,
      refreshAdminCache,
      preloadSheetSnapshots,
      sendOrUpdateAdminMessage,
      sheets,
      cache
    });
    return;
  }

  if (action === "promptall") {
    await ensureSheetReadiness(sheets, config, cache);
    const users = (await listUsers()).filter((user) => user.appointment);

    if (users.length === 0) {
      await sendOrUpdateAdminMessage(ctx, "No bound users found yet.");
      return;
    }

    let sent = 0;

    for (const user of users) {
      try {
        await sendPromptToChat(bot, config, user.chatId, cache);
        sent += 1;
      } catch (error) {
        console.error(`Failed to prompt chat ${user.chatId}:`, error.message);
      }
    }

    await sendOrUpdateAdminMessage(ctx, `Attendance prompt sent to ${sent} bound user(s).`);
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

async function sendPromptToChat(bot, config, chatId, cache = null) {
  const user = await getUserByChatId(chatId);
  const today = new Date();
  const dateLabel = formatAttendanceDateLabel(today, config.timezone);
  const currentStatus = user?.appointment && cache
    ? getCachedAttendanceStatus(cache, config, user.appointment, today)
    : "";
  const message = buildTodayAttendancePromptMessage(
    config,
    today,
    user?.appointment ?? null,
    cache
  );
  const promptMessage = currentStatus
    ? `Your attendance for ${dateLabel} is currently ${currentStatus}. Update it if needed.`
    : `You have not updated your attendance for ${dateLabel}. ${message}`;
  await bot.telegram.sendMessage(
    chatId,
    promptMessage,
    buildInlineAttendanceMenu(
      config.attendanceOptions,
      0,
      "home:pick:attendance",
      "home:attendance:page",
      "home:main"
    )
  );
  // Only set awaitingAttendance if no status is on file; users who already filed
  // should not be put into a text-prompt state just from receiving the reminder.
  await updateUserByChatId(chatId, {
    awaitingAttendance: !currentStatus,
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

  if (user?.appointment) {
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

async function handleSyncRosterAdminAction(ctx, config, deps) {
  const timeoutMs = deps.timeoutMs ?? 8000;

  await deps.sendOrUpdateAdminMessage(
    ctx,
    "Syncing roster with Google Sheets. If Google is slow, this will stop early instead of hanging."
  );

  try {
    const roster = await withUiOperationTimeout(
      "Roster sync",
      async () => {
        const nextRoster = await deps.syncRosterState(deps.sheets, config);
        await deps.ensureNextMonthSheetExists(deps.sheets, config);
        await deps.refreshAdminCache(deps.cache, config);
        await deps.preloadSheetSnapshots(deps.sheets, config, deps.cache, { force: true });
        return nextRoster;
      },
      timeoutMs
    );

    await deps.sendOrUpdateAdminMessage(
      ctx,
      `Roster synced from ${config.onboardingSheetTitle}. Current month: ${roster.currentMonthTitle}. Next month: ${roster.nextMonthTitle}.`
    );
  } catch (error) {
    if (error?.name === "UiOperationTimeoutError") {
      await deps.sendOrUpdateAdminMessage(
        ctx,
        "Roster sync is taking too long because Google Sheets is slow. Please try again later."
      );
      return;
    }

    throw error;
  }
}

async function handleOptionsResetAction(ctx, config, deps) {
  const timeoutMs = deps.timeoutMs ?? 8000;

  await deps.sendOrUpdateAdminMessage(
    ctx,
    "Resetting attendance options and refreshing active sheets. This will stop early if Google Sheets is slow."
  );

  try {
    await withUiOperationTimeout(
      "Attendance option reset",
      async () => {
        await deps.resetAttendanceOptions();
        config.attendanceOptions = [...config.onboardingAttendanceOptions];
        await deps.syncRosterState(deps.sheets, config);
        await deps.ensureNextMonthSheetExists(deps.sheets, config);
        await deps.refreshAdminCache(deps.adminCache, config);
        await deps.preloadSheetSnapshots(deps.sheets, config, deps.adminCache, { force: true });
      },
      timeoutMs
    );

    await deps.sendOrUpdateAdminMessage(
      ctx,
      "Attendance options have been reset to the settings.yaml default list.",
      buildAttendanceOptionsMenu()
    );
  } catch (error) {
    if (error?.name === "UiOperationTimeoutError") {
      await deps.sendOrUpdateAdminMessage(
        ctx,
        "Attendance option reset is taking too long because Google Sheets is slow. Please try again later."
      );
      return;
    }

    throw error;
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
  const runDailySheetMaintenanceFn = deps.runDailySheetMaintenanceFn ?? runDailySheetMaintenance;

  // Startup: lightweight read-only sync (no structural writes), followed by
  // attendance option sort once the sync finishes — serialized to avoid
  // hammering the Sheets API with concurrent requests.
  const startupSyncPromise = adminCache.syncManager
    .runCycle({ force: false, reason: "startup" })
    .then(() => refreshAttendanceOptionUsageFn(sheets, config, adminCache))
    .catch((error) => {
      console.error("Initial startup sync/sort failed:", error);
    });

  // If maintenance hasn't run in over 20 hours, schedule it shortly after startup
  // rather than waiting until the next midnight cron.  Wait for the startup sync
  // to finish first so we don't flood the API.
  getLastStructuralMaintenanceAt()
    .then((lastMaintenanceAt) => {
      const lastMaint = lastMaintenanceAt ? Date.parse(lastMaintenanceAt) : 0;
      const staleMs = 20 * 60 * 60 * 1000; // 20 hours

      if (Date.now() - lastMaint > staleMs) {
        console.log("Scheduling deferred startup maintenance (last run: " +
          (lastMaintenanceAt ?? "never") + ")");
        setTimeoutFn(async () => {
          try {
            // Wait for the startup sync cycle + option sort to finish before
            // issuing more API calls.
            await startupSyncPromise;
            await runDailySheetMaintenanceFn(sheets, config);
            await syncAppointmentRegistry();
            await syncOnboardingCodeColumn(
              sheets,
              config,
              (await getAppointmentRegistry()).appointments.filter((entry) => entry.active)
            );
            await refreshAdminCache(adminCache, config);
            await refreshAttendanceOptionUsageFn(sheets, config, adminCache);
          } catch (error) {
            console.error("Deferred startup maintenance failed:", error);
          }
        }, 10_000);
      }
    })
    .catch(() => {
      // Non-fatal; the midnight cron will run maintenance at the next opportunity.
    });

  setIntervalFn(async () => {
    try {
      await adminCache.syncManager.runCycle({ force: false, reason: "background" });
    } catch (error) {
      console.error("Background sheet preload failed:", error);
    }
  }, 60 * 1000);

  setIntervalFn(async () => {
    try {
      await adminCache.syncManager.runCycle({ force: true, reason: "five-minute" });
    } catch (error) {
      console.error("Five-minute sheet reconciliation failed:", error);
    }
  }, 5 * 60 * 1000);

  // Midnight: full structural maintenance (sheet creation, row sync, layout, protections).
  scheduleFn(
    "0 0 * * *",
    async () => {
      try {
        await runDailySheetMaintenanceFn(sheets, config);
        await syncAppointmentRegistry();
        await syncOnboardingCodeColumn(
          sheets,
          config,
          (await getAppointmentRegistry()).appointments.filter((entry) => entry.active)
        );
        await refreshAdminCache(adminCache, config);
        await refreshAttendanceOptionUsageFn(sheets, config, adminCache);
      } catch (error) {
        console.error("Midnight sheet maintenance failed:", error);
      }
    },
    { timezone: config.timezone }
  );

  // 00:05: queue compaction only (cheap local file operation).
  scheduleFn(
    "5 0 * * *",
    async () => {
      try {
        const result = await compactAttendanceQueue();

        if (result.compacted) {
          console.log(`Nightly queue compaction removed ${result.removedCount} resolved records.`);
        }
      } catch (error) {
        console.error("Nightly queue compaction failed:", error);
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

        try {
          await adminCache.syncManager.runCycle({ force: true, reason: "reminder" });
        } catch (error) {
          console.error(`Unable to refresh sheet state before ${reminderTime} reminder:`, error);
        }

        const users = (await listUsersFn()).filter((user) => {
          if (!user.appointment) {
            return false;
          }

          if (reminderTime === config.firstReminderTime) {
            return true;
          }

          return hasUnfilledAttendance(adminCache, config, user.appointment, now);
        });

        for (const user of users) {
          try {
            await sendPromptToChatFn(bot, config, user.chatId, adminCache);
          } catch (error) {
            console.error(
              `Failed to send scheduled ${reminderTime} prompt to ${user.chatId}:`,
              error.message
            );
          }
        }
      },
      { timezone: config.timezone }
    );
  }
}

export function createAttendanceBot(config) {
  const bot = new Telegraf(config.telegramBotToken, {
    telegram: {
      agent: ipv4HttpsAgent
    }
  });
  const sheets = createGoogleSheetsClient(config);
  const adminCache = createAdminCache();
  adminCache.syncManager = createSyncManager({
    flushQueue: async () =>
      withSheetOperation(async () =>
        flushAttendanceQueue((entries) => reconcilePendingAttendanceWithSheets(sheets, config, entries, {
          force: true
        }))
      ),
    // refreshOnboarding is intentionally a no-op in the hot-path cycle.
    // Onboarding data is read as part of refreshMonthSlices (via refreshMonthSlice →
    // refreshOnboardingSlice with TTL). Full structural roster sync runs once a day
    // via the midnight maintenance cron.
    refreshOnboarding: async () => false,
    refreshMonthSlices: async (options = {}) => withSheetOperation(async () => {
      await preloadSheetSnapshots(sheets, config, adminCache, {
        ...options,
        structural: false,
        normalizeAliases: options.reason === "five-minute"
      });
      return true;
    }),
    refreshAdminCache: async () => {
      await refreshAdminCache(adminCache, config);
    }
  });

  refreshAdminCache(adminCache, config).catch((error) => {
    console.error("Initial admin cache hydrate failed:", error);
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
      console.error("Initial local snapshot hydrate failed:", error);
    });

  bot.use(
    session({
      defaultSession: () => ({
        awaitingAttendance: false,
        awaitingSecretCode: false,
        awaitingAppointmentAdd: false,
        awaitingWeeklyAttendance: false,
        departmentEditTarget: null,
        weeklyAttendanceDates: [],
        weeklyAttendanceIndex: 0,
        weeklyAttendanceResults: [],
        weeklyAttendanceEntries: []
      })
    })
  );

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
    const user = await getUserByChatId(ctx.chat.id);

    if (!user?.appointment || !user?.onboardingCompletedAt) {
      await resetConversationState(ctx);
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
    const result = await deregisterRequestorByChatId(ctx.chat.id);

    if (!result.ok) {
      const messages = {
        not_bound: "You are not currently onboarded."
      };
      await ctx.reply(messages[result.reason] || "Unable to deregister your account.");
      return;
    }

    await ctx.reply(
      [
        `You have been deregistered from ${result.appointment}.`,
        "Your previous registration code has been rotated.",
        "You will need a fresh invitation code to onboard again."
      ].join("\n")
    );
    await refreshAdminCache(adminCache, config);
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

    const result = await addAdminAppointment(appointment);

    if (!result.ok) {
      const messages = {
        appointment_not_found: "Appointment not found in the active roster.",
        appointment_not_bound: "That appointment is not currently onboarded and cannot be made an admin."
      };
      await ctx.reply(messages[result.reason] || "Unable to add that admin.");
      return;
    }

    await ctx.reply(`${result.appointment} now has admin access.`);
    await refreshAdminCache(adminCache, config);
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

    const result = await removeAdminAppointment(
      appointment,
      config.defaultAdminAppointments
    );

    if (!result.ok) {
      const messages = {
        default_admin: "That is a default admin appointment and cannot be removed.",
        admin_not_found: "That appointment does not currently have custom admin access."
      };
      await ctx.reply(messages[result.reason] || "Unable to remove that admin.");
      return;
    }

    await ctx.reply(`${result.appointment} no longer has custom admin access.`);
    await refreshAdminCache(adminCache, config);
  });

  bot.command("addappointment", async (ctx) => {
    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    const appointment = getCommandArgument(ctx.message.text, "addappointment");

    if (!appointment) {
      ctx.session.awaitingAppointmentAdd = true;
      await sendOrUpdateAdminMessage(
        ctx,
        "Send the appointment name exactly as it should appear in the roster.",
        buildAppointmentManagementBackMenu()
      );
      return;
    }

    const result = await addManagedAppointment(sheets, config, adminCache, appointment);
    await ctx.reply(
      result.ok
        ? `${result.appointment} has been added to the active roster. Secret code: ${result.secretCode}`
        : result.reason === "appointment_exists"
          ? `${result.appointment} is already in the active roster.`
          : "Unable to add that appointment."
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

    const result = await removeManagedAppointment(sheets, config, adminCache, appointment);
    await ctx.reply(
      result.ok
        ? `${result.appointment} has been removed from the active roster.`
        : "Appointment not found in the active roster."
    );
  });

  bot.on("text", async (ctx) => {
    const message = ctx.message.text.trim();
    const storedUser = await getUserByChatId(ctx.chat.id);
    const awaitingSecretCode =
      ctx.session.awaitingSecretCode || storedUser?.awaitingSecretCode === true;
    const awaitingAttendance =
      ctx.session.awaitingAttendance || storedUser?.awaitingAttendance === true;
    const awaitingWeeklyAttendance =
      ctx.session.awaitingWeeklyAttendance || storedUser?.awaitingWeeklyAttendance === true;
    const awaitingAttendanceOptionAdd = ctx.session.awaitingAttendanceOptionAdd === true;
    const awaitingAppointmentAdd = ctx.session.awaitingAppointmentAdd === true;

    if (awaitingAppointmentAdd) {
      if (!(await requireAdmin(ctx, config))) {
        ctx.session.awaitingAppointmentAdd = false;
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

      ctx.session.awaitingAppointmentAdd = false;
      const result = await addManagedAppointment(
        sheets,
        config,
        adminCache,
        normalizedAppointment
      );
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? `${result.appointment} has been added to the active roster.\nSecret code: ${result.secretCode}`
          : result.reason === "appointment_exists"
            ? `${result.appointment} is already in the active roster.`
            : "Unable to add that appointment.",
        buildAppointmentManagementBackMenu()
      );
      return;
    }

    if (awaitingAttendanceOptionAdd) {
      if (!(await requireAdmin(ctx, config))) {
        ctx.session.awaitingAttendanceOptionAdd = false;
        return;
      }

      const normalizedOption = String(message ?? "").trim().toUpperCase();

      if (!normalizedOption) {
        await sendOrUpdateAdminMessage(
          ctx,
          "Attendance option cannot be empty. Send the new code to add it.",
          Markup.inlineKeyboard([
            [
              Markup.button.callback("🔙 Back", "admin:menu:options"),
              Markup.button.callback("❌", "admin:close")
            ]
          ])
        );
        return;
      }

      if (config.attendanceOptions.includes(normalizedOption)) {
        ctx.session.awaitingAttendanceOptionAdd = false;
        await sendOrUpdateAdminMessage(
          ctx,
          `${normalizedOption} is already in the attendance option list.`,
          buildAttendanceOptionsMenu()
        );
        return;
      }

      ctx.session.awaitingAttendanceOptionAdd = false;
      await applyAttendanceOptionChange(
        sheets,
        config,
        adminCache,
        [...config.attendanceOptions, normalizedOption]
      );
      await sendOrUpdateAdminMessage(
        ctx,
        `${normalizedOption} has been added to the attendance options.`,
        buildAttendanceOptionsMenu()
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
    console.error("Telegram bot error:", error);
    ctx.reply("Something went wrong while processing your request. Try again.");
  });

  bot.action(/home:(.+)/, async (ctx) => {
    const action = ctx.match[1];

    if (
      !action.startsWith("pick:attendance:") &&
      !action.startsWith("department:pickoption:") &&
      action !== "pick:week:skip" &&
      !action.startsWith("pick:week:")
    ) {
      await ctx.answerCbQuery();
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

      const [, , departmentKey, weekOffsetRaw, pageRaw, absoluteIndexRaw, dayIndexRaw] = action.split(":");
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

      if (!viewModel.ok || !targetMember || !targetDate) {
        await renderDepartmentView(ctx, config, adminCache, user, {
          departmentKey,
          weekOffset: Number(weekOffsetRaw ?? 0),
          page: Number(pageRaw ?? 0),
          isAdminUser
        });
        return;
      }

      ctx.session.departmentEditTarget = {
        appointment: targetMember.appointment,
        date: targetDate.toISOString(),
        departmentKey: viewModel.departmentKey,
        weekOffset: viewModel.weekOffset,
        page: viewModel.page
      };
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
        buildInlineAttendanceMenu(
          config.attendanceOptions,
          0,
          "home:department:pickoption",
          "home:department:pickpage",
          `home:department:view:${viewModel.departmentKey}:${viewModel.weekOffset}:${viewModel.page}`
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

      const target = ctx.session.departmentEditTarget;

      if (!target) {
        await renderDepartmentView(ctx, config, adminCache, user, {
          isAdminUser: await isAdmin(ctx, config)
        });
        return;
      }

      const page = Number(action.split(":")[2] ?? 0);
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
          "home:department:pickpage",
          `home:department:view:${target.departmentKey}:${target.weekOffset}:${target.page}`
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

      const target = ctx.session.departmentEditTarget;

      if (!target) {
        await renderDepartmentView(ctx, config, adminCache, user, {
          isAdminUser: await isAdmin(ctx, config)
        });
        return;
      }

      const picked = config.attendanceOptions[Number(action.split(":")[2])];

      if (!picked) {
        await renderDepartmentView(ctx, config, adminCache, user, {
          departmentKey: target.departmentKey,
          weekOffset: target.weekOffset,
          page: target.page,
          isAdminUser: await isAdmin(ctx, config)
        });
        return;
      }

      const targetDate = new Date(target.date);
      await queueAttendanceSelection(
        adminCache,
        config,
        target.appointment,
        picked,
        targetDate,
        "department"
      );
      ctx.session.departmentEditTarget = null;
      await updateUserByChatId(ctx.chat.id, {
        awaitingAttendance: false,
        lastSubmittedAt: new Date().toISOString()
      });
      await ctx.answerCbQuery("Attendance updated");
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

    if (action.startsWith("attendance:page:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:attendance:page");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const page = Number(action.split(":")[2]);
      const date = new Date();
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
        buildInlineAttendanceMenu(
          config.attendanceOptions,
          page,
          "home:pick:attendance",
          "home:attendance:page",
          "home:main"
        )
      );
      return;
    }

    if (action.startsWith("pick:attendance:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:pick:attendance");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const picked = config.attendanceOptions[Number(action.split(":")[2])];

      if (!picked) {
        await ctx.answerCbQuery();
        await askAttendance(ctx, config, user, adminCache);
        return;
      }

      const recordedAt = new Date();
      await queueAttendanceSelection(
        adminCache,
        config,
        user.appointment,
        picked,
        recordedAt,
        "daily"
      );
      const confirmationLines = [
        `Attendance recorded as "${picked}" for ${user.appointment} for ${formatAttendanceDateLabel(recordedAt, config.timezone)} at ${formatMilitaryTime(recordedAt, config.timezone)} hrs.`,
        "Queued for Google Sheets sync.",
        "",
        `"${pickQuoteOrJoke()}"`
      ];

      if (isAfterAttendanceReminderCutoff(recordedAt, config.timezone)) {
        confirmationLines.splice(
          1,
          0,
          "Remember to record your attendance on time tomorrow, please.",
          ""
        );
      }

      await updateUserByChatId(ctx.chat.id, {
        awaitingAttendance: false,
        lastSubmittedAt: new Date().toISOString()
      });

      await ctx.answerCbQuery("Attendance updated");

      await sendOrUpdateAdminMessage(
        ctx,
        confirmationLines.join("\n"),
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Back", "home:main"),
            Markup.button.callback("❌ Close", "home:close")
          ]
        ])
      );
      return;
    }

    if (action.startsWith("week:page:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:week:page");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      await promptWeeklyAttendanceDay(
        ctx,
        config,
        user,
        adminCache,
        Number(action.split(":")[2])
      );
      return;
    }

    if (action === "pick:week:skip" || action.startsWith("pick:week:")) {
      triggerBackgroundSheetRefresh(adminCache, "home:pick:week");
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const storedUser = await getUserByChatId(ctx.chat.id);
      const weeklyDates =
        ctx.session.weeklyAttendanceDates?.length > 0
          ? ctx.session.weeklyAttendanceDates
          : storedUser?.weeklyAttendanceDates ?? [];
      const weeklyIndex = Number.isInteger(ctx.session.weeklyAttendanceIndex)
        ? ctx.session.weeklyAttendanceIndex
        : Number(storedUser?.weeklyAttendanceIndex ?? 0);
      const weeklyResults = Array.isArray(ctx.session.weeklyAttendanceResults)
        ? ctx.session.weeklyAttendanceResults
        : Array.isArray(storedUser?.weeklyAttendanceResults)
          ? storedUser.weeklyAttendanceResults
          : [];
      const weeklyEntries = Array.isArray(ctx.session.weeklyAttendanceEntries)
        ? ctx.session.weeklyAttendanceEntries
        : Array.isArray(storedUser?.weeklyAttendanceEntries)
          ? storedUser.weeklyAttendanceEntries
          : [];
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
      let pickedPayload = null;

      if (action !== "pick:week:skip") {
        const picked = config.attendanceOptions[Number(action.split(":")[2])];

        if (!picked) {
          await ctx.answerCbQuery();
          await promptWeeklyAttendanceDay(ctx, config, user, adminCache);
          return;
        }

        nextEntries = upsertWeeklyAttendanceEntry(
          weeklyEntries,
          isoDate,
          picked,
          (value) => toIsoDateString(value, config.timezone)
        );
        pickedPayload = {
          status: picked,
          entries: nextEntries
        };
        await ctx.answerCbQuery(`Saved: ${picked}`);
      } else if (currentStatus) {
        await ctx.answerCbQuery("Kept current status");
      } else {
        await ctx.answerCbQuery("Skipped");
      }

      const nextState = applyWeeklyAttendanceSelection(
        {
          awaitingWeeklyAttendance: true,
          weeklyAttendanceDates: weeklyDates,
          weeklyAttendanceIndex: weeklyIndex,
          weeklyAttendanceResults: weeklyResults,
          weeklyAttendanceEntries: weeklyEntries
        },
        {
          action: action === "pick:week:skip" ? "skip" : "pick",
          dateValue,
          currentStatus,
          pickedStatus: pickedPayload,
          formatWeekDateLabel: (value) => formatWeekDateLabel(value, config.timezone)
        }
      );

      ctx.session.weeklyAttendanceResults = nextState.weeklyAttendanceResults;
      ctx.session.weeklyAttendanceIndex = nextState.weeklyAttendanceIndex;
      ctx.session.weeklyAttendanceEntries = nextState.weeklyAttendanceEntries;

      await updateUserByChatId(ctx.chat.id, {
        awaitingWeeklyAttendance: nextState.awaitingWeeklyAttendance,
        weeklyAttendanceResults: nextState.weeklyAttendanceResults,
        weeklyAttendanceIndex: nextState.weeklyAttendanceIndex,
        weeklyAttendanceEntries: nextState.weeklyAttendanceEntries,
        lastSubmittedAt: new Date().toISOString()
      });

      if (!nextState.awaitingWeeklyAttendance) {
        await finalizeWeeklyAttendanceFlow(ctx, config, user.appointment, adminCache);
        return;
      }

      await promptWeeklyAttendanceDay(ctx, config, user, adminCache);
      return;
    }

    if (action === "deregister") {
      await sendOrUpdateAdminMessage(
        ctx,
        [
          "Warning",
          "Deregistering will remove your Telegram binding immediately.",
          "Your registration code will be rotated.",
          "You will need a fresh invitation to onboard again."
        ].join("\n"),
        buildSelfDeregisterMenu()
      );
      return;
    }

    if (action === "deregister:confirm") {
      const result = await deregisterRequestorByChatId(ctx.chat.id);

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
              Markup.button.callback("❌", "home:close")
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
            Markup.button.callback("❌", "home:close")
          ]
        ])
      );
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
    await ctx.answerCbQuery();
    const isAdminUser = await isAdmin(ctx, config);
    await sendOrUpdateAdminMessage(
      ctx,
      buildManualText(sectionKey, isAdminUser),
      buildManualMenu(isAdminUser)
    );
  });

  bot.action(/admin:(.+)/, async (ctx) => {
    const action = ctx.match[1];
    await ctx.answerCbQuery();

    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    if (action === "main") {
      await sendOrUpdateAdminMessage(ctx, buildAdminMenuDescription(), buildAdminMenu());
      return;
    }

    if (action === "close") {
      await ctx.editMessageText("Admin menu closed.");
      return;
    }

    if (action === "menu:roster") {
      await sendOrUpdateAdminMessage(ctx, buildRosterDescription(), buildAdminRosterMenu());
      return;
    }

    if (action === "menu:options") {
      await renderAttendanceOptionsMenu(ctx, config);
      return;
    }

    if (action === "menu:options") {
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
      ctx.session.awaitingAppointmentAdd = true;
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

    if (action === "menu:admins") {
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
      ctx.session.awaitingAttendanceOptionAdd = true;
      await sendOrUpdateAdminMessage(
        ctx,
        "Send the new attendance option code exactly as you want it to appear.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Back", "admin:menu:options"),
            Markup.button.callback("❌", "admin:close")
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
      await handleOptionsResetAction(ctx, config, {
        resetAttendanceOptions,
        syncRosterState,
        ensureNextMonthSheetExists,
        refreshAdminCache,
        preloadSheetSnapshots,
        sendOrUpdateAdminMessage,
        sheets,
        adminCache
      });
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
          "Attendance option usage has been refreshed. Display order remains canonical.",
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

    if (action.startsWith("pick:code:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      const pending = adminCache.pending;
      const picked = pending[Number(action.split(":")[2])];

      if (!picked) {
        await renderCodesSubmenu(ctx, adminCache);
        return;
      }

      const invite = await getOnboardingInvite(picked.appointment);
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
      const candidates = adminCache.inviteCandidates;
      const picked = candidates[Number(action.split(":")[2])];

      if (!picked) {
        await renderInviteSubmenu(ctx, adminCache, 0);
        return;
      }

      const invite = await getOnboardingInvite(picked.appointment);
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
      const candidates = adminCache.addAdminCandidates;
      const picked = candidates[Number(action.split(":")[2])];

      if (!picked) {
        await renderAddAdminSubmenu(ctx, adminCache, 0);
        return;
      }

      const result = await addAdminAppointment(picked.appointment);
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? `${result.appointment} now has admin access.`
          : result.reason === "appointment_not_bound"
            ? "That appointment is not currently onboarded and cannot be made an admin."
            : "Appointment not found in the active roster.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Back", "admin:menu:admins"),
            Markup.button.callback("❌", "admin:close")
          ]
        ])
      );
      await refreshAdminCache(adminCache, config);
      return;
    }

    if (action.startsWith("pick:deregister:")) {
      const candidates = adminCache.deregisterCandidates;
      const picked = candidates[Number(action.split(":")[2])];

      if (!picked) {
        await renderDeregisterSubmenu(ctx, adminCache, 0);
        return;
      }

      const result = await deregisterAppointmentBinding(picked.appointment);
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? `Deregistered ${result.appointment}. The person will need to onboard again.`
          : "Unable to deregister that account.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Back", "admin:menu:deregister:0"),
            Markup.button.callback("❌", "admin:close")
          ]
        ])
      );
      await refreshAdminCache(adminCache, config);
      return;
    }

    if (action.startsWith("pick:appointmentremove:")) {
      const candidates = adminCache.removeAppointmentCandidates;
      const picked = candidates[Number(action.split(":")[2])];

      if (!picked) {
        await renderRemoveAppointmentSubmenu(ctx, adminCache, 0);
        return;
      }

      const result = await removeManagedAppointment(
        sheets,
        config,
        adminCache,
        picked.appointment
      );
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? `${result.appointment} has been removed from the active roster.`
          : "Appointment not found in the active roster.",
        buildAppointmentManagementBackMenu()
      );
      return;
    }

    if (action.startsWith("pick:removeadmin:")) {
      const candidates = adminCache.removeAdminCandidates;
      const picked = candidates[Number(action.split(":")[2])];

      if (!picked) {
        await renderRemoveAdminSubmenu(ctx, adminCache, 0);
        return;
      }

      const result = await removeAdminAppointment(
        picked.appointment,
        config.defaultAdminAppointments
      );
      await sendOrUpdateAdminMessage(
        ctx,
        result.ok
          ? `${result.appointment} no longer has custom admin access.`
          : "Unable to remove that admin.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Back", "admin:menu:admins"),
            Markup.button.callback("❌", "admin:close")
          ]
        ])
      );
      await refreshAdminCache(adminCache, config);
      return;
    }

    if (action.startsWith("pick:optionremove:")) {
      const option = config.attendanceOptions[Number(action.split(":")[2])];

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

      await applyAttendanceOptionChange(
        sheets,
        config,
        adminCache,
        config.attendanceOptions.filter((entry) => entry !== option)
      );
      await sendOrUpdateAdminMessage(
        ctx,
        `${option} has been removed from the attendance options.`,
        buildAttendanceOptionsMenu()
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
  formatDepartmentViewMessage,
  buildSummaryMenu,
  formatSummaryMessage,
  formatHomeSynchronizationTimestamp,
  getCanonicalAttendanceOptions,
  getDepartmentKeyForAppointment,
  getLatestHomeSynchronizationTimestamp,
  handleInviteCommand,
  handleOnboardCommand,
  handleOptionsResetAction,
  handleSyncRosterAdminAction,
  triggerBackgroundSheetRefresh,
  renderInviteSubmenu,
  renderAttendanceOptionsMenu,
  registerBackgroundSchedules
};
