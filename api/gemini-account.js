import {createGeminiAccount} from '../lib/gemini-account.js';

export const config={api:{bodyParser:false}};
export function createHandler({account=createGeminiAccount()}={}) {return account.handler;}
export default createHandler();
