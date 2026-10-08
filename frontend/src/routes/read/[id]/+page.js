/** @type {import('./$types').PageLoad} */
import { currentTranscription } from '$lib/stores';
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';

export async function load({ params }) {
    // Same payload the editor loads: the reading view needs the full result with
    // segments and speaker labels, which the list endpoint does not return.
    const endpoint = browser ? `${env.PUBLIC_API_HOST}/api/transcriptions` : `${env.PUBLIC_INTERNAL_API_HOST}/api/transcriptions`;
    const response = await fetch(`${endpoint}/${params.id}`);
    const ts = await response.json();
    currentTranscription.set(ts);
};
