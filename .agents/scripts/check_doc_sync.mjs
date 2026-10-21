import { execSync } from 'child_process';
import path from 'path';

try {
  // Get modified files in working tree
  const statusOutput = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (!statusOutput) {
    process.exit(0);
  }

  const changedFiles = statusOutput
    .split('\n')
    .map(line => line.trim().slice(3).trim())
    .filter(Boolean);

  // Filter out documentation-only files
  const sourceChanges = changedFiles.filter(f => {
    const norm = f.replace(/\\/g, '/');
    return !(
      norm.endsWith('.md') ||
      norm.endsWith('.drawio') ||
      norm.startsWith('docs/') ||
      norm === 'CHANGELOG.md' ||
      norm === 'README.md' ||
      norm === '.env.example'
    );
  });

  if (sourceChanges.length > 0) {
    console.log(`[DOC-SYNC-HOOK] Detected ${sourceChanges.length} modified source file(s):`);
    sourceChanges.slice(0, 5).forEach(f => console.log(`  - ${f}`));
    console.log(`[DOC-SYNC-HOOK] Triggering automatic documentation & architecture synchronization...`);
  } else {
    // Only documentation files modified -> prevent loop and exit
    process.exit(0);
  }
} catch (e) {
  // Safe fallback if git is unavailable
  process.exit(0);
}
