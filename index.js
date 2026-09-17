const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    MessageFlags
} = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = require(CONFIG_PATH);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

if (!config.scores) {
    config.scores = {};
}

let questionsCache = [];
let currentQuestion = null;
let currentQuestionMsg = null;
let leaderboardMsg = null;
let solvedUsers = new Set();
let attemptedUsers = new Set();

function saveConfig() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
function formatApiText(text) {
    if (!text || text === 'null' || text === 'undefined') return '';

    return text
        .replace(/\\begin\{[a-z0-9*]+\}/gi, '')
        .replace(/\\end\{[a-z0-9*]+\}/gi, '')
        .replace(/\\text\{([^}]+)\}/g, '$1')
        .replace(/\\\((.*?)\\\)/g, '$1')
        .replace(/\\frac\{1\}\{2\}/g, '½')
        .replace(/\\frac\{1\}\{4\}/g, '¼')
        .replace(/\\frac\{3\}\{4\}/g, '¾')
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1/$2)')
        .replace(/\\sqrt\{([^}]+)\}/g, '√$1')
        .replace(/\^2/g, '²')
        .replace(/\^3/g, '³')
        .replace(/\\times/g, '×')
        .replace(/\\div/g, '÷')
        .replace(/\\le/g, '≤')
        .replace(/\\ge/g, '≥')
        .replace(/\\neq/g, '≠')
        .replace(/\$([^$]+)\$/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}
function getLatexImageUrl(text) {
    if (!text || text === 'null') return null;
    const hasMath = /\$([^$]+)\$|\\frac|\\sqrt|\\begin\{align\}/;
    if (!hasMath.test(text)) return null;
    const match = text.match(/\$([^$]+)\$/);
    const latexFormula = match ? match[1] : text;
    const cleanFormula = latexFormula
        .replace(/\\begin\{align\}|\\end\{align\}/g, '')
        .trim();

    return `https://quickchart.io/chart?cht=tx&chl=${encodeURIComponent(cleanFormula)}`;
}

function getCorrectAnswer(qObj) {
    if (!qObj) return null;
    if (qObj.correct_answer) return String(qObj.correct_answer).trim().toUpperCase();
    if (qObj.question && qObj.question.correct_answer) return String(qObj.question.correct_answer).trim().toUpperCase();
    return null;
}

function getExplanation(qObj) {
    if (!qObj) return 'No reasoning provided for this question.';
    if (qObj.explanation && qObj.explanation !== 'null') return formatApiText(qObj.explanation);
    if (qObj.question && qObj.question.explanation && qObj.question.explanation !== 'null') return formatApiText(qObj.question.explanation);
    if (qObj.reasoning && qObj.reasoning !== 'null') return formatApiText(qObj.reasoning);
    return 'No reasoning provided for this question.';
}

function getFormattedTimestampPST() {
    return new Date().toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function buildQuestionEmbed(questionObj, solvedList = []) {
    const solvedText = solvedList.length > 0 
        ? solvedList.map(id => `<@${id}>`).join(', ') 
        : 'None yet!';

    const choicesText = `**A)** ${formatApiText(questionObj.question.choices.A)}\n` +
                        `**B)** ${formatApiText(questionObj.question.choices.B)}\n` +
                        `**C)** ${formatApiText(questionObj.question.choices.C)}\n` +
                        `**D)** ${formatApiText(questionObj.question.choices.D)}`;

    const rawParagraph = questionObj.question.paragraph;
    const cleanParagraph = formatApiText(rawParagraph);
    const cleanQuestion = formatApiText(questionObj.question.question);

    let description = `**Domain:** *${questionObj.domain}*\n\n`;
    if (cleanParagraph.length > 0) {
        description += `**Passage / Prompt**\n${cleanParagraph}\n\n`;
    }
    description += `Question: ${cleanQuestion}\n\n` +
                   `**Choices**\n${choicesText}\n\n` +
                   `**Solved By**\n${solvedText}`;

    const embed = new EmbedBuilder()
        .setTitle('SAT Prep')
        .setColor('#2F3136')
        .setDescription(description)
        .setFooter({ 
            text: `New question every 60 min (PST-aligned) • Click a button to answer. • ${getFormattedTimestampPST()}` 
        });

    const imageUrl = getLatexImageUrl(rawParagraph) || getLatexImageUrl(questionObj.question.question);
    if (imageUrl) embed.setImage(imageUrl);

    return embed;
}

function buildSolutionEmbed(questionObj) {
    const cleanExplanation = getExplanation(questionObj);
    const answerKey = getCorrectAnswer(questionObj);

    const embed = new EmbedBuilder()
        .setTitle('Previous Question — Solution')
        .setColor('#1ABC9C')
        .setDescription(
            `**Correct Answer**\n**${answerKey}**\n\n` +
            `**Reasoning**\n${cleanExplanation}`
        );

    const imageUrl = getLatexImageUrl(cleanExplanation);
    if (imageUrl) embed.setImage(imageUrl);

    return embed;
}

function buildLeaderboardEmbed() {
    const sorted = Object.entries(config.scores).sort((a, b) => b[1] - a[1]);
    let desc = 'Rankings of our best test-prep masters.\n\n';

    if (sorted.length === 0) {
        desc += '*No participants yet!*';
    } else {
        const badges = ['🥇', '🥈', '🥉'];
        sorted.forEach(([userId, score], index) => {
            const badge = badges[index] || '🏅';
            desc += `${badge} <@${userId}> — **${score} pts**\n`;
        });
    }

    return new EmbedBuilder()
        .setTitle('SAT Leaderboard')
        .setColor('#F1C40F')
        .setDescription(desc)
        .setFooter({ text: `Who's the best? • ${getFormattedTimestampPST()}` });
}

async function fetchQuestions() {
    try {
        console.log('Fetching questions from API...');
        let allQuestions = [];

        const sectionsToFetch = config.allowedSections && config.allowedSections.length > 0 
            ? config.allowedSections 
            : ['MATH', 'ENGLISH'];
        const requests = sectionsToFetch.map(section => 
            axios.get(`https://pinesat.duckdns.org/api/questions?section=${encodeURIComponent(section)}`)
                .catch(err => {
                    console.error(`Failed to fetch section ${section}:`, err.message);
                    return { data: [] };
                })
        );
        const responses = await Promise.all(requests);
        responses.forEach(res => {
            if (Array.isArray(res.data)) {
                allQuestions.push(...res.data);
            }
        });
        if (config.allowedDifficulties && config.allowedDifficulties.length > 0) {
            allQuestions = allQuestions.filter(q => config.allowedDifficulties.includes(q.difficulty));
        }

        questionsCache = allQuestions;
        console.log(`Loaded ${questionsCache.length} total questions (Math & English) into cache.`);
    } catch (err) {
        console.error('Error fetching questions from API:', err.message);
    }
}
async function updateLeaderboardChannel() {
    try {
        const lbChannel = await client.channels.fetch(config.leaderboardChannelId);
        if (!lbChannel) return;

        const embed = buildLeaderboardEmbed();
        const messages = await lbChannel.messages.fetch({ limit: 10 });
        const existingMsg = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title === 'SAT Leaderboard');

        if (existingMsg) {
            leaderboardMsg = await existingMsg.edit({ embeds: [embed] });
        } else {
            leaderboardMsg = await lbChannel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error('Failed to update leaderboard channel:', err.message);
    }
}

async function postNextQuestion(qChannel) {
    if (questionsCache.length === 0) {
        await fetchQuestions();
        if (questionsCache.length === 0) return;
    }
    if (currentQuestionMsg) {
        try {
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ans_A').setLabel('A').setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId('ans_B').setLabel('B').setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId('ans_C').setLabel('C').setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId('ans_D').setLabel('D').setStyle(ButtonStyle.Primary).setDisabled(true)
            );
            await currentQuestionMsg.edit({ components: [disabledRow] });
        } catch (e) {
            console.error('Could not disable buttons on previous message:', e.message);
        }
    }

    if (currentQuestion) {
        const solutionEmbed = buildSolutionEmbed(currentQuestion);
        await qChannel.send({ embeds: [solutionEmbed] });
    }

    solvedUsers.clear();
    attemptedUsers.clear();

    const randomIndex = Math.floor(Math.random() * questionsCache.length);
    currentQuestion = questionsCache[randomIndex];

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ans_A').setLabel('A').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ans_B').setLabel('B').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ans_C').setLabel('C').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ans_D').setLabel('D').setStyle(ButtonStyle.Primary)
    );

    const questionEmbed = buildQuestionEmbed(currentQuestion, []);
    currentQuestionMsg = await qChannel.send({ 
        embeds: [questionEmbed], 
        components: [row] 
    });

    await updateLeaderboardChannel();
}

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('ans_')) return;

    const userId = interaction.user.id;
    const selectedAnswer = interaction.customId.replace('ans_', '').toUpperCase();

    if (attemptedUsers.has(userId)) {
        return interaction.reply({ 
            content: '❌ You have already submitted an answer for this question!', 
            flags: MessageFlags.Ephemeral 
        });
    }

    attemptedUsers.add(userId);

    const correctAnswer = getCorrectAnswer(currentQuestion);
    const isCorrect = (selectedAnswer === correctAnswer);

    if (!config.scores[userId]) config.scores[userId] = 0;

    if (isCorrect) {
        config.scores[userId] += 1;
        solvedUsers.add(userId);
        saveConfig();

        const updatedEmbed = buildQuestionEmbed(currentQuestion, Array.from(solvedUsers));
        await currentQuestionMsg.edit({ embeds: [updatedEmbed] });

        await updateLeaderboardChannel();

        await interaction.reply({ content: '✅ Correct answer!', flags: MessageFlags.Ephemeral });
    } else {
        config.scores[userId] -= 1;
        saveConfig();

        await updateLeaderboardChannel();

        await interaction.reply({ content: `❌ Incorrect! You picked **${selectedAnswer}**, but the correct answer was **${correctAnswer}**.`, flags: MessageFlags.Ephemeral });
    }
});

client.once('clientReady', async () => {
    console.log(`Bot logged in as ${client.user.tag}`);
    await fetchQuestions();

    const qChannel = await client.channels.fetch(config.channelId);

    if (qChannel && !currentQuestion) {
        await postNextQuestion(qChannel);
    }

    cron.schedule('0 0,16-23 * * *', async () => {
        console.log('Triggering scheduled SAT question...');
        if (qChannel) {
            await postNextQuestion(qChannel);
        }
    }, {
        timezone: "America/Los_Angeles"
    });
});

client.login(config.token);