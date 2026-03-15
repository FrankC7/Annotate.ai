import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';

let extractor: FeatureExtractionPipeline | undefined;

export async function initEmbeddings() {
    if (!extractor) {
        // Use all-MiniLM-L6-v2 which produces 384-dimensional embeddings
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
}

export async function getEmbedding(text: string): Promise<number[]> {
    if (!extractor) {
        await initEmbeddings();
    }
    
    // Generate embedding
    const output = await extractor!(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

// Simple text chunker for splitting large files
export function chunkText(text: string, maxTokens: number = 250): { text: string; startLine: number; endLine: number }[] {
    const lines = text.split('\n');
    const chunks: { text: string; startLine: number; endLine: number }[] = [];
    
    let currentChunkLines: string[] = [];
    let currentWordCount = 0;
    let startLine = 1;
    
    // Very rough heuristic: ~1.5 tokens per programming line word, aim for maxTokens
    const WORDS_PER_CHUNK = maxTokens;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const wordCount = line.split(/\s+/).filter(w => w.length > 0).length;
        
        currentChunkLines.push(line);
        currentWordCount += wordCount > 0 ? wordCount : 1; // Count blank lines slightly
        
        if (currentWordCount >= WORDS_PER_CHUNK || i === lines.length - 1) {
            chunks.push({
                text: currentChunkLines.join('\n'),
                startLine: startLine,
                endLine: i + 1
            });
            
            // Overlap by 2 lines for context continuity
            const overlapCount = Math.min(2, currentChunkLines.length);
            currentChunkLines = currentChunkLines.slice(currentChunkLines.length - overlapCount);
            currentWordCount = currentChunkLines.reduce((acc, l) => acc + l.split(/\s+/).filter(w => w.length > 0).length, 0);
            startLine = (i + 1) - overlapCount + 1;
        }
    }
    
    return chunks;
}
