import cron from "node-cron";
import { Markup, Telegraf, session } from "telegraf";
import {
  createGoogleSheetsClient,
  ensureNextMonthSheetExists,
  preloadAttendanceSnapshots,
  syncOnboardingCodeColumn,
  syncOnboardingRoster,
  summarizeStatuses,
  summarizeStatusesFromSnapshot,
  writeAttendanceStatus,
  writeAttendanceStatuses
} from "./googleSheets.js";
import {
  addAdminAppointment,
  bindAppointmentCode,
  deregisterAppointmentBinding,
  deregisterRequestorByChatId,
  getAppointmentRegistry,
  getUserByChatId,
  getOnboardingInvite,
  listAdminAppointments,
  listUsers,
  removeAdminAppointment,
  syncAppointmentRegistry,
  updateUserByChatId,
  upsertUser
} from "./storage.js";

const WEEK_SKIP_LABEL = "Skip Day";
const SINGAPORE_PUBLIC_HOLIDAY_COLLECTION_ID = "691";
const publicHolidayCache = {
  years: new Map(),
  loadingPromise: null
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
      Markup.button.callback("🧾 Deregister Person", "admin:menu:deregister:0"),
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
    [Markup.button.callback("🔄 Sync Roster", "admin:syncroster")],
    [
      Markup.button.callback("🔙 Back", "admin:main"),
      Markup.button.callback("❌", "admin:close")
    ]
  ]);
}

function buildHomeMenu(isAdminUser, timezone) {
  const weekButtons = getHomeWeekButtons(timezone);
  const rows = [
    [Markup.button.callback("📝 Today's Attendance", "home:attendance")],
    weekButtons,
    [
      Markup.button.callback("⚠️ Deregister", "home:deregister"),
      Markup.button.callback("📊 Summary", "home:summary")
    ],
    [
      Markup.button.callback("❓ Help", "home:help"),
      Markup.button.callback("❌ Close", "home:close")
    ]
  ];

  if (isAdminUser) {
    rows.splice(1, 0, [
      Markup.button.callback("🛠️ Admin Menu", "home:admin")
    ]);
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

function buildSummaryMenu(date, timezone, backTarget = "admin:menu:roster") {
  const previousDate = toIsoDateString(shiftDate(date, -1), timezone);
  const nextDate = toIsoDateString(shiftDate(date, 1), timezone);
  const namespace = backTarget.startsWith("home:") ? "home" : "admin";

  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⬅️ Previous Day", `${namespace}:summary:${previousDate}`),
      Markup.button.callback("Next Day ➡️", `${namespace}:summary:${nextDate}`)
    ],
    [Markup.button.callback("🕳️ Unaccounted", `${namespace}:summary:unaccounted:${toIsoDateString(date, timezone)}`)],
    [
      Markup.button.callback("🔙 Back", backTarget),
      Markup.button.callback("❌", `${namespace}:close`)
    ]
  ]);
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

function buildInviteMessage(invite, bot) {
  const botLink = bot.botInfo?.username
    ? `https://t.me/${bot.botInfo.username}`
    : "Open the attendance bot in Telegram";

  return [
    `Hello ${invite.appointment},`,
    "",
    "Please register for the attendance bot.",
    `1. Open the bot: ${botLink}`,
    "2. Send /start",
    `3. Enter your registration code: ${invite.secretCode}`,
    "",
    "Copy and paste the code exactly when the bot asks for it."
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

function sortAppointmentsForAdmin(items) {
  const priority = new Map([
    ["CO", 0],
    ["XO", 1],
    ["COXN", 2],
    ["SCSE", 3],
    ["OPS 1", 4]
  ]);

  return [...items].sort((left, right) => {
    const leftKey = left.appointment.toUpperCase();
    const rightKey = right.appointment.toUpperCase();
    const leftPriority = priority.has(leftKey) ? priority.get(leftKey) : Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.has(rightKey) ? priority.get(rightKey) : Number.MAX_SAFE_INTEGER;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return left.appointment.localeCompare(right.appointment);
  });
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

function getStagedAttendanceStatus(entries, date, timezone) {
  const isoDate = typeof date === "string" ? date : toIsoDateString(date, timezone);
  const entry = [...entries].reverse().find((value) => value.date === isoDate);
  return entry?.status ?? "";
}

function upsertWeeklyAttendanceEntry(entries, date, status, timezone) {
  const isoDate = typeof date === "string" ? date : toIsoDateString(date, timezone);
  const nextEntries = entries.filter((entry) => entry.date !== isoDate);
  nextEntries.push({ date: isoDate, status });
  return nextEntries;
}

function formatSyncStatusTimestamp(timestamp, timezone) {
  if (!timestamp) {
    return "Not completed yet";
  }

  return formatCorrectAsAt(new Date(timestamp), timezone);
}

function buildAdminMenuDescription() {
  return [
    "Admin Menu",
    "",
    "Use this menu to manage roster operations and onboarding support.",
    "",
    "📋 Roster: View onboarding gaps and run a manual roster sync.",
    "✉️ Send Invitation: Generate and forward an invitation for personnel who have not onboarded.",
    "👮 Manage Admins: Review current admins and add or remove admin appointments.",
    "📣 Prompt All: Send the attendance prompt to all currently bound users.",
    "🧾 Deregister Person: Remove another person’s Telegram binding and rotate their code.",
    "🔙 Back: Return to the main home menu."
  ].join("\n");
}

function buildManageAdminsDescription(admins) {
  const lines = [
    "Manage Admins",
    "",
    "Current admin appointments:"
  ];

  if (admins.length === 0) {
    lines.push("None");
  } else {
    lines.push(...admins.map((entry) => `• ${entry.appointment} (${entry.source})`));
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
    "🔄 Sync Roster refreshes the ONBOARDING sheet, secret codes, and monthly attendance sheets."
  ].join("\n");
}

function getCachedSummarySnapshot(cache, config, date) {
  return summarizeStatusesFromSnapshot(cache.sheetSnapshots, config, { date }) ?? null;
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

function buildChatUrlForRegistryEntry(entry) {
  if (entry?.boundUsername) {
    return `https://t.me/${entry.boundUsername}`;
  }

  if (entry?.boundUserId) {
    return `tg://user?id=${entry.boundUserId}`;
  }

  if (entry?.boundChatId) {
    return `tg://user?id=${entry.boundChatId}`;
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

function formatSummaryMessage(summary, config) {
  const counts = summary.summary;
  const asAt = summary.synchronizedAt ? new Date(summary.synchronizedAt) : new Date();

  return [
    `<b><u>Summary</u></b>`,
    `<b>${formatFullDateLabel(summary.date, config.timezone)}</b>`,
    `<i>Correct as at ${formatCorrectAsAt(asAt, config.timezone)}</i>`,
    "",
    `<b>Total:</b> ${counts.total}`,
    "",
    `<u><b>Attendance</b></u>`,
    `<b>Present:</b> ${counts.present}`,
    `<b>TNB:</b> ${counts.tnb}`,
    "",
    `<b>Accounted Attendance:</b> ${counts.accountedAttendance}`,
    `<b>Unaccounted:</b> ${counts.unaccounted}`,
    "",
    `<u><b>Status Breakdown</b></u>`,
    `<b>Outstation (OS):</b> ${counts.os}`,
    `<b>Overseas Duty (OSD):</b> ${counts.osd}`,
    `<b>IPPT:</b> ${counts.ippt}`,
    `<b>ORCA:</b> ${counts.orca}`,
    `<b>FMSS:</b> ${counts.fmss}`,
    `<b>Outside Event (OE):</b> ${counts.oe}`,
    `<b>Local Leave (LL):</b> ${counts.ll}`,
    `<b>Overseas Leave (OL):</b> ${counts.ol}`,
    `<b>On Course (OC):</b> ${counts.oc}`,
    `<b>Attached Out (AO):</b> ${counts.ao}`,
    `<b>Report Sick (RSO/RSI):</b> ${counts.rsoRsi}`,
    `<b>MC/OML:</b> ${counts.mcOml}`,
    `<b>Childcare Leave (CCL):</b> ${counts.ccl}`,
    `<b>Child Sick Leave (CSL):</b> ${counts.csl}`,
    `<b>Paternity Leave (PTL):</b> ${counts.ptl}`,
    `<b>Parent Care Leave (PCL):</b> ${counts.pcl}`,
    `<b>Reverse Routine (RR):</b> ${counts.rr}`,
    `<b>Sunday Routine (SR):</b> ${counts.sr}`,
    `<b>Medical Appointment (MA):</b> ${counts.ma}`,
    `<b>Work From Home (WFH):</b> ${counts.wfh}`,
    `<b>OFF/OIL:</b> ${counts.offOil}`,
    `<b>COMPASSIONATE:</b> ${counts.compassionate}`,
    `<b>Hospitalisation Leave (HL):</b> ${counts.hl}`,
    `<b>Public Holiday (PH):</b> ${counts.ph}`,
    `<b>SHRO:</b> ${counts.shro}`,
    `<b>YARD:</b> ${counts.yard}`,
    `<b>FISHING:</b> ${counts.fishing}`
  ].join("\n");
}

function createAdminCache() {
  return {
    lastSheetSyncAt: 0,
    syncPromise: null,
    lastSnapshotSyncAt: 0,
    snapshotPromise: null,
    sheetSnapshots: null,
    pending: [],
    activeCodes: [],
    admins: [],
    inviteCandidates: [],
    deregisterCandidates: [],
    addAdminCandidates: [],
    removeAdminCandidates: []
  };
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

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function loadSingaporePublicHolidayCache() {
  if (publicHolidayCache.loadingPromise) {
    await publicHolidayCache.loadingPromise;
    return;
  }

  publicHolidayCache.loadingPromise = (async () => {
    const metadata = await fetchJson(
      `https://api-production.data.gov.sg/v2/public/api/collections/${SINGAPORE_PUBLIC_HOLIDAY_COLLECTION_ID}/metadata`
    );
    const datasetIds = metadata?.data?.collectionMetadata?.childDatasets ?? [];

    for (const datasetId of datasetIds) {
      try {
        const payload = await fetchJson(
          `https://data.gov.sg/api/action/datastore_search?resource_id=${datasetId}`
        );
        const records = payload?.result?.records ?? [];

        for (const record of records) {
          const rawDate = String(record.date ?? "").trim();

          if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
            continue;
          }

          const year = Number(rawDate.slice(0, 4));

          if (!publicHolidayCache.years.has(year)) {
            publicHolidayCache.years.set(year, new Set());
          }

          publicHolidayCache.years.get(year).add(rawDate);
        }
      } catch (error) {
        console.error(`Failed to load public holiday dataset ${datasetId}:`, error.message);
      }
    }
  })().finally(() => {
    publicHolidayCache.loadingPromise = null;
  });

  await publicHolidayCache.loadingPromise;
}

async function getSingaporePublicHolidaySet(year) {
  if (!publicHolidayCache.years.has(year)) {
    await loadSingaporePublicHolidayCache();
  }

  return publicHolidayCache.years.get(year) ?? new Set();
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

async function finalizeWeeklyAttendanceFlow(ctx, sheets, config, appointment) {
  const results = Array.isArray(ctx.session.weeklyAttendanceResults)
    ? ctx.session.weeklyAttendanceResults
    : [];
  const entries = Array.isArray(ctx.session.weeklyAttendanceEntries)
    ? ctx.session.weeklyAttendanceEntries
    : [];

  if (entries.length > 0) {
    await writeAttendanceStatuses(
      sheets,
      config,
      entries.map((entry) => ({
        appointment,
        status: entry.status,
        date: new Date(entry.date)
      }))
    );
  }

  await clearWeeklyAttendanceState(ctx);
  await sendOrUpdateAdminMessage(
    ctx,
    ["Weekly attendance updated:", "", ...results].join("\n"),
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
  await ctx.reply(config.onboardingCodePrompt, Markup.removeKeyboard());
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
    config.timezone
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
      !getStagedAttendanceStatus(weeklyEntries, isoDate, config.timezone) &&
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
  ctx.session.awaitingAttendance = false;
  ctx.session.awaitingWeeklyAttendance = true;
  ctx.session.weeklyAttendanceDates = getWorkweekDates(config.timezone, weekOffset);
  ctx.session.weeklyAttendanceIndex = 0;
  ctx.session.weeklyAttendanceResults = [];
  ctx.session.weeklyAttendanceEntries = [];

  await updateUserByChatId(ctx.chat.id, {
    awaitingAttendance: false,
    awaitingWeeklyAttendance: true,
    weeklyAttendanceDates: ctx.session.weeklyAttendanceDates,
    weeklyAttendanceIndex: 0,
    weeklyAttendanceResults: [],
    weeklyAttendanceEntries: []
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
  const descriptions = [
    "📝 Today's Attendance: Submit or update your attendance for today.",
    ...getHomeWeekDescriptions(config.timezone),
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

  const text = [
    `${greeting}, ${name}.`,
    "",
    "Choose an action below:",
    "",
    ...descriptions,
    "",
    "---"
  ].join("\n");

  await sendOrUpdateAdminMessage(ctx, text, buildHomeMenu(isAdminUser, config.timezone));
}

async function syncRosterState(sheets, config) {
  const roster = await syncOnboardingRoster(sheets, config);
  const registry = await syncAppointmentRegistry(roster.onboardingAppointments);
  await syncOnboardingCodeColumn(
    sheets,
    config,
    registry.appointments.filter((entry) => entry.active)
  );
  return roster;
}

async function preloadSheetSnapshots(sheets, config, cache, options = {}) {
  const force = options.force === true;
  const now = Date.now();

  if (!force && cache.sheetSnapshots && now - cache.lastSnapshotSyncAt < 60_000) {
    return cache.sheetSnapshots;
  }

  if (!cache.snapshotPromise) {
    cache.snapshotPromise = preloadAttendanceSnapshots(sheets, config)
      .then((snapshotBundle) => {
        cache.sheetSnapshots = snapshotBundle;
        cache.lastSnapshotSyncAt = Date.now();
        return snapshotBundle;
      })
      .finally(() => {
        cache.snapshotPromise = null;
      });
  }

  return cache.snapshotPromise;
}

async function refreshAdminCache(cache, config) {
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
  cache.addAdminCandidates = activeCodes
    .filter((entry) => !adminSet.has(entry.appointment.toUpperCase()))
    .map((entry) => ({ label: entry.appointment, appointment: entry.appointment }));
  cache.removeAdminCandidates = admins
    .filter((entry) => entry.source === "custom")
    .map((entry) => ({ label: entry.appointment, appointment: entry.appointment }));

  cache.inviteCandidates = sortAppointmentsForAdmin(cache.inviteCandidates);
  cache.addAdminCandidates = sortAppointmentsForAdmin(cache.addAdminCandidates);
  cache.removeAdminCandidates = sortAppointmentsForAdmin(cache.removeAdminCandidates);
}

async function ensureSheetReadiness(sheets, config, cache, options = {}) {
  const force = options.force === true;
  const now = Date.now();
  const hasWarmCache =
    cache.activeCodes.length > 0 || cache.admins.length > 0 || cache.sheetSnapshots !== null;

  if (!force && now - cache.lastSheetSyncAt < config.sheetSyncMinIntervalMs) {
    if (cache.activeCodes.length === 0 && cache.admins.length === 0) {
      await refreshAdminCache(cache, config);
    }
    return;
  }

  if (!cache.syncPromise) {
    cache.syncPromise = (async () => {
      await syncRosterState(sheets, config);
      cache.lastSheetSyncAt = Date.now();
      await refreshAdminCache(cache, config);
      await preloadSheetSnapshots(sheets, config, cache, { force: true });
    })().finally(() => {
      cache.syncPromise = null;
    });
  }

  if (!force && hasWarmCache) {
    return;
  }

  await cache.syncPromise;
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
    "Select a person to generate and send a forwardable invitation message.",
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
    "Select a person to generate a forwardable onboarding message.",
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

async function runAdminAction(action, ctx, bot, sheets, config, cache) {
  if (!(await requireAdmin(ctx, config))) {
    return;
  }

  if (action === "pending") {
    await ensureSheetReadiness(sheets, config, cache);
    const pending = cache.pending;
    await ctx.reply(
      pending.length === 0
        ? "All active personnel have onboarded."
        : pending.map((entry) => `${entry.appointment} - ${entry.secretCode}`).join("\n"),
      Markup.removeKeyboard()
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
    const roster = await syncRosterState(sheets, config);
    await ensureNextMonthSheetExists(sheets, config);
    cache.lastSheetSyncAt = Date.now();
    await refreshAdminCache(cache, config);
    await sendOrUpdateAdminMessage(
      ctx,
      `Roster synced from ${config.onboardingSheetTitle}. Current month: ${roster.currentMonthTitle}. Next month: ${roster.nextMonthTitle}.`
    );
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
    await preloadSheetSnapshots(sheets, config, cache);
    const summary =
      getCachedSummarySnapshot(cache, config, targetDate) ??
      (await summarizeStatuses(sheets, config, { date: targetDate }));
    await sendOrUpdateAdminMessage(
      ctx,
      formatSummaryMessage(summary, config),
      buildSummaryMenu(targetDate, config.timezone),
      { parse_mode: "HTML" }
    );
    return;
  }

  if (action.startsWith("summary:")) {
    if (action.startsWith("summary:unaccounted:")) {
      const targetDate = parseIsoDate(action.split(":")[2]);

      if (!targetDate) {
        await sendOrUpdateAdminMessage(ctx, "Invalid summary date.", buildAdminRosterMenu());
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

    await preloadSheetSnapshots(sheets, config, cache);
    const summary =
      getCachedSummarySnapshot(cache, config, targetDate) ??
      (await summarizeStatuses(sheets, config, { date: targetDate }));
    await sendOrUpdateAdminMessage(
      ctx,
      formatSummaryMessage(summary, config),
      buildSummaryMenu(targetDate, config.timezone),
      { parse_mode: "HTML" }
    );
    return;
  }
}

async function sendPromptToChat(bot, config, chatId, cache = null) {
  const user = await getUserByChatId(chatId);
  const message = buildTodayAttendancePromptMessage(
    config,
    new Date(),
    user?.appointment ?? null,
    cache
  );
  await bot.telegram.sendMessage(
    chatId,
    message,
    buildInlineAttendanceMenu(
      config.attendanceOptions,
      0,
      "home:pick:attendance",
      "home:attendance:page",
      "home:main"
    )
  );
  await updateUserByChatId(chatId, {
    awaitingAttendance: true,
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

export function createAttendanceBot(config) {
  const bot = new Telegraf(config.telegramBotToken);
  const sheets = createGoogleSheetsClient(config);
  const adminCache = createAdminCache();

  bot.use(
    session({
      defaultSession: () => ({
        awaitingAttendance: false,
        awaitingSecretCode: false,
        awaitingWeeklyAttendance: false,
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
    await registerUser(ctx);
    await ensureSheetReadiness(sheets, config, adminCache);
    await resetConversationState(ctx);
    await ctx.reply(
      [
        "This bot writes your attendance into the shared monthly Google Sheet.",
        "To bind your Telegram account securely, enter the secret code assigned to your appointment."
      ].join("\n")
    );
    await askForSecretCode(ctx, config);
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

    await renderHomeMenu(ctx, config, { user });
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
    const preloadStatus = adminCache.syncPromise || adminCache.snapshotPromise
      ? "Background synchronisation is in progress."
      : "Background synchronisation is idle.";

    await ctx.reply(
      [
        "Google Sheets synchronisation status:",
        `Roster sync: ${formatSyncStatusTimestamp(adminCache.lastSheetSyncAt, config.timezone)}`,
        `Snapshot sync: ${formatSyncStatusTimestamp(adminCache.lastSnapshotSyncAt, config.timezone)}`,
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
    if (!(await requireAdmin(ctx, config))) {
      return;
    }

    await ensureSheetReadiness(sheets, config, adminCache);
    const appointment = getCommandArgument(ctx.message.text, "invite");

    if (!appointment) {
      await renderInviteSubmenu(ctx, adminCache, 0);
      return;
    }

    const invite = await getOnboardingInvite(appointment);

    if (!invite.ok) {
      await ctx.reply("Appointment not found in the active onboarding roster.");
      return;
    }

    await ctx.reply(
      buildInviteMessage(invite, bot),
      buildInviteReplyMarkup(invite, bot)
    );
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

  bot.on("text", async (ctx) => {
    const message = ctx.message.text.trim();
    const storedUser = await getUserByChatId(ctx.chat.id);
    const awaitingSecretCode =
      ctx.session.awaitingSecretCode || storedUser?.awaitingSecretCode === true;
    const awaitingAttendance =
      ctx.session.awaitingAttendance || storedUser?.awaitingAttendance === true;
    const awaitingWeeklyAttendance =
      ctx.session.awaitingWeeklyAttendance || storedUser?.awaitingWeeklyAttendance === true;

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
        user: await getUserByChatId(ctx.chat.id)
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

    if (!action.startsWith("pick:attendance:") && action !== "pick:week:skip" && !action.startsWith("pick:week:")) {
      await ctx.answerCbQuery();
    }

    if (action === "main") {
      await renderHomeMenu(ctx, config);
      return;
    }

    if (action === "close") {
      await sendOrUpdateAdminMessage(ctx, "Menu closed.");
      return;
    }

    if (action === "attendance") {
      await ensureSheetReadiness(sheets, config, adminCache);
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      await askAttendance(ctx, config, user, adminCache);
      return;
    }

    if (action === "week") {
      await ensureSheetReadiness(sheets, config, adminCache);
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const weekOffset = getWeekdayIndex(config.timezone) >= 5 ? 1 : 0;
      await startWeeklyAttendanceFlow(ctx, config, sheets, user, adminCache, weekOffset);
      return;
    }

    if (action === "week:this" || action === "week:next") {
      await ensureSheetReadiness(sheets, config, adminCache);
      const user = await ensureUserBound(ctx, config);

      if (!user) {
        return;
      }

      const weekOffset = action === "week:next" ? 1 : 0;
      await startWeeklyAttendanceFlow(ctx, config, sheets, user, adminCache, weekOffset);
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
      await ensureSheetReadiness(sheets, config, adminCache);
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
      await ensureSheetReadiness(sheets, config, adminCache);
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

      await writeAttendanceStatus(sheets, config, {
        appointment: user.appointment,
        status: picked,
        date: new Date()
      });
      const recordedAt = new Date();
      const confirmationLines = [
        `Attendance recorded as "${picked}" for ${user.appointment} for ${formatAttendanceDateLabel(recordedAt, config.timezone)} at ${formatMilitaryTime(recordedAt, config.timezone)} hrs.`,
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
      await ensureSheetReadiness(sheets, config, adminCache);
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
      await ensureSheetReadiness(sheets, config, adminCache);
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
      const label = formatWeekDateLabel(date, config.timezone);
      const isoDate = toIsoDateString(date, config.timezone);
      const currentStatus =
        getStagedAttendanceStatus(weeklyEntries, isoDate, config.timezone) ||
        getCachedAttendanceStatus(adminCache, config, user.appointment, date);
      let resultLine = `${label}: skipped`;
      let nextEntries = weeklyEntries;

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
          config.timezone
        );
        resultLine = `${label}: ${picked}`;
        await ctx.answerCbQuery(`Saved: ${picked}`);
      } else if (currentStatus) {
        resultLine = `${label}: ${currentStatus}`;
        await ctx.answerCbQuery("Kept current status");
      } else {
        await ctx.answerCbQuery("Skipped");
      }

      const nextResults = [...weeklyResults, resultLine];
      const nextIndex = weeklyIndex + 1;

      ctx.session.weeklyAttendanceResults = nextResults;
      ctx.session.weeklyAttendanceIndex = nextIndex;
      ctx.session.weeklyAttendanceEntries = nextEntries;

      await updateUserByChatId(ctx.chat.id, {
        awaitingWeeklyAttendance: nextIndex < weeklyDates.length,
        weeklyAttendanceResults: nextResults,
        weeklyAttendanceIndex: nextIndex,
        weeklyAttendanceEntries: nextEntries,
        lastSubmittedAt: new Date().toISOString()
      });

      if (nextIndex >= weeklyDates.length) {
        await finalizeWeeklyAttendanceFlow(ctx, sheets, config, user.appointment);
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
      await preloadSheetSnapshots(sheets, config, adminCache);
      const summary =
        getCachedSummarySnapshot(adminCache, config, targetDate) ?? (
          await summarizeStatuses(sheets, config, {
            date: targetDate
          })
        );
      await sendOrUpdateAdminMessage(
        ctx,
        formatSummaryMessage(summary, config),
        buildSummaryMenu(targetDate, config.timezone, "home:main"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (action.startsWith("summary:unaccounted:")) {
      const targetDate = parseIsoDate(action.split(":")[2]);

      if (!targetDate) {
        await renderHomeMenu(ctx, config);
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
        await renderHomeMenu(ctx, config);
        return;
      }

      await preloadSheetSnapshots(sheets, config, adminCache);
      const summary =
        getCachedSummarySnapshot(adminCache, config, targetDate) ?? (
          await summarizeStatuses(sheets, config, {
            date: targetDate
          })
        );
      await sendOrUpdateAdminMessage(
        ctx,
        formatSummaryMessage(summary, config),
        buildSummaryMenu(targetDate, config.timezone, "home:main"),
        { parse_mode: "HTML" }
      );
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

    if (action.startsWith("menu:invite:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      await renderInviteSubmenu(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action.startsWith("menu:deregister:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      await renderDeregisterSubmenu(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action === "menu:admins") {
      await sendOrUpdateAdminMessage(
        ctx,
        buildManageAdminsDescription(adminCache.admins),
        buildAdminManageMenu()
      );
      return;
    }

    if (action.startsWith("menu:codes:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      await renderCodesSubmenuPage(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action.startsWith("menu:addadmin:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      await renderAddAdminSubmenu(ctx, adminCache, Number(action.split(":")[2]));
      return;
    }

    if (action.startsWith("menu:removeadmin:")) {
      await ensureSheetReadiness(sheets, config, adminCache);
      await renderRemoveAdminSubmenu(ctx, adminCache, Number(action.split(":")[2]));
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
        buildInviteMessage(invite, bot),
        buildInviteReplyMarkup(invite, bot, "admin:menu:codes:0")
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
        buildInviteMessage(invite, bot),
        buildInviteReplyMarkup(invite, bot, "admin:menu:invite:0")
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

    await runAdminAction(action, ctx, bot, sheets, config, adminCache);
  });

  ensureSheetReadiness(sheets, config, adminCache, { force: true }).catch((error) => {
    console.error("Initial roster sync failed:", error);
  });

  setInterval(async () => {
    try {
      await ensureSheetReadiness(sheets, config, adminCache, { force: true });
    } catch (error) {
      console.error("Background sheet preload failed:", error);
    }
  }, 60 * 1000);

  const scheduledReminderTimes = [
    config.firstReminderTime,
    config.secondReminderTime
  ].filter(Boolean);

  for (const reminderTime of scheduledReminderTimes) {
    const [hour, minute] = reminderTime.split(":");

    cron.schedule(
      `${Number(minute)} ${Number(hour)} * * *`,
      async () => {
        const now = new Date();
        const shouldSendReminder = await isReminderWorkingDay(now, config.timezone);

        if (!shouldSendReminder) {
          return;
        }

        try {
          // Scheduled reminders should act on the latest cached sheet state so the
          // second reminder only reaches people who are still blank at that moment.
          await ensureSheetReadiness(sheets, config, adminCache, { force: true });
        } catch (error) {
          console.error(`Unable to refresh sheet state before ${reminderTime} reminder:`, error);
          return;
        }

        const users = (await listUsers()).filter(
          (user) => user.appointment && hasUnfilledAttendance(adminCache, config, user.appointment, now)
        );

        for (const user of users) {
          try {
            await sendPromptToChat(bot, config, user.chatId, adminCache);
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

  return bot;
}
