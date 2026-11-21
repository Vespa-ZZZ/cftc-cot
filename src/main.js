import { Actor, log } from 'apify';
import { sanitize } from './cot.js';
import { runActor } from './run.js';

await Actor.init();

try {
    const count = await runActor((await Actor.getInput()) ?? {}, {
        actor: Actor,
        warn: (message) => log.warning(message),
    });
    log.info(`Pushed ${count} CFTC report rows.`);
    await Actor.exit();
} catch (error) {
    const message = sanitize(error?.message ?? error);
    log.error(message);
    await Actor.fail(message);
}
