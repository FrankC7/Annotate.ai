import { DataAPIClient, Db } from '@datastax/astra-db-ts';

let astraClient: DataAPIClient | undefined;
let astraDb: Db | undefined;

export interface AstraCredentials {
    endpoint: string;
    token: string;
}

export function initAstra(credentials: AstraCredentials): Db {
    if (!astraClient) {
        astraClient = new DataAPIClient(credentials.token);
    }
    astraDb = astraClient.db(credentials.endpoint);
    return astraDb;
}

export function getAstraDb(): Db | undefined {
    return astraDb;
}

export async function ensureCollections(db: Db) {
    const collections = await db.listCollections();
    const collectionNames = collections.map((c: any) => c.name);

    if (!collectionNames.includes('code_snippets')) {
        await db.createCollection('code_snippets', {
            vector: {
                dimension: 384, // Xenova/all-MiniLM-L6-v2 dimension
                metric: 'cosine',
            },
        });
        console.log("Created collection: code_snippets");
    }

    if (!collectionNames.includes('commit_history')) {
        await db.createCollection('commit_history', {
            vector: {
                dimension: 384, // Xenova/all-MiniLM-L6-v2 dimension
                metric: 'cosine',
            },
        });
        console.log("Created collection: commit_history");
    }
}
