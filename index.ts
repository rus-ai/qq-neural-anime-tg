type UserSession = {
    userId: number;
    ctx: Context;
    photoId: string;
};

import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';
import { v4 as v4uuid } from 'uuid';
import axios, { type AxiosError } from 'axios';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();
const KEEP_FILES = !!(+(process.env.KEEP_FILES ?? '1') || 0); // "true" by default

const qqRequest = async (imgData: string) => {
    const uuid = v4uuid();

    let response;
    let data;
    for (let retry = 0; retry < 100; retry++) {
        try {
            response = await axios.request({
                method: 'POST',
                url: 'https://ai.tu.qq.com/trpc.shadow_cv.ai_processor_cgi.AIProcessorCgi/Process',
                data: {
                    busiId: 'ai_painting_anime_entry',
                    extra: JSON.stringify({
                        face_rects: [],
                        version: 2,
                        platform: 'web',
                        data_report: {
                            parent_trace_id: uuid,
                            root_channel: '',
                            level: 0,
                        },
                    }),
                    images: [imgData],
                },
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            });
        } catch (e) {
            response = (e as AxiosError).response;
        }

        data = response?.data as Record<string, unknown> | undefined;

        if (data?.msg === 'IMG_ILLEGAL') {
            throw new Error('Couldn\'t pass the censorship. Try another photo.');
        }

        if (data?.msg === 'VOLUMN_LIMIT') {
            retry--;
            console.log('QQ rate limit caught');
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        if (data?.code === 1001) {
            throw new Error('No face in image');
        }

        if (data?.extra) {
            break;
        }
    }

    if (data?.extra) {
        const extra = JSON.parse(data.extra as string);
        return {
            video: extra.video_urls[0],
            img: extra.img_urls[1],
        };
    } else {
        throw new Error(JSON.stringify(response?.data));
    }
};

const qqDownload = async (url: string): Promise<Buffer> => {
    let response;
    for (let retry = 0; retry < 100; retry++) {
        try {
            response = await axios.request({
                url,
                timeout: 10000,
                responseType: 'arraybuffer',
            });
        } catch (e) {
            response = (e as AxiosError).response;
            console.error('QQ file download error caught: ' + (e as AxiosError).toString());
        }

        if (response?.data) {
            break;
        }
    }

    return response?.data;
};

const userSessions: Array<UserSession> = [];

const processUserSession = async ({ userId, photoId, ctx }: UserSession) => {
    try {
        const url = await ctx.telegram.getFileLink(photoId);

        let response;
        for (let retry = 0; retry < 100; retry++) {
            try {
                response = await axios.request({
                    url: url.href,
                    timeout: 10000,
                    responseType: 'arraybuffer',
                });
            } catch (e) {}

            if (response?.data) {
                break;
            }
        }

        if (!response) {
            console.log('Couldn\'t load the photo from ' + userId);
            throw new Error('Couldn\'t load the photo, please try again');
        }

        if (KEEP_FILES) {
            fs.writeFile(
                path.join(__dirname, 'files', (new Date()).getTime() + '_' + userId + '_input.jpg'),
                response.data,
            );
        }

        console.log('Uploading to QQ for ' + userId);
        await ctx.reply('Photo has been received, uploading to QQ');
        const urls = await qqRequest(response.data.toString('base64'));
        console.log('QQ responded successfully for ' + userId);

        await ctx.reply('Downloading the result from QQ');
        console.log('Downloading from QQ for ' + userId);
        const [videoData, imgData] = await Promise.all([
            qqDownload(urls.video),
            qqDownload(urls.img),
        ]);

        if (KEEP_FILES) {
            fs.writeFile(
                path.join(__dirname, 'files', (new Date()).getTime() + '_' + userId + '_output_img.jpg'),
                imgData,
            );
        }

        await Promise.all([
            ctx.replyWithPhoto({
                source: imgData,
            }),
            ctx.replyWithVideo({
                source: videoData,
            }),
        ]);
        console.log('Files sent to ' + userId);

        await ctx.reply('Done.\nPlease, rate and fork me on Github ♥️ https://github.com/lmcsu/qq-neural-anime-tg', {
            disable_web_page_preview: true,
        });
    } catch (e) {
        ctx.reply('Some nasty error has occurred\n\n' + (e as Error).toString()).catch(e => e);
        console.log('Error has occurred for ' + userId);
        console.error(e);
    }

    const currentSessionIndex = userSessions.findIndex((session) => session.userId === userId);
    userSessions.splice(currentSessionIndex, 1);
    console.log('Sessions length decreased: ' + userSessions.length);
};

const addUserSession = async (userId: number, photoId: string, ctx: Context) => {
    const currentSession = (userSessions.find((session) => session.userId === userId));
    if (currentSession) {
        await ctx.reply('You are already in the queue, please wait');
        return;
    }

    const session = {
        userId,
        photoId,
        ctx,
    };
    userSessions.push(session);
    console.log('Sessions length increased: ' + userSessions.length);

    await processUserSession(session);
};

const bot = new Telegraf(process.env.BOT_TOKEN || '');

bot.start((ctx) => ctx.reply('Send me the picture you want to convert').catch((e) => e));

bot.on('photo', (ctx) => {
    const userId = ctx.update.message.from.id;
    console.log('Received photo from ' + userId);

    const photoId = [...ctx.update.message.photo].pop()?.file_id || '';
    addUserSession(userId, photoId, ctx).catch(e => e);
});

bot.catch((e) => {
    console.error('Bot error has occurred ', e);
})

bot.launch();

let shuttingDown = false;
const shutDown = async (reason: string) => {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    bot.stop(reason);
};

process.once('unhandledRejection', () => shutDown('unhandledRejection'));
process.once('uncaughtException', () => shutDown('uncaughtException'));
process.once('SIGINT', () => shutDown('SIGINT'));
process.once('SIGTERM', () => shutDown('SIGTERM'));
