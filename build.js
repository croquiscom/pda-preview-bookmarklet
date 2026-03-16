const fs = require('fs');
const { execSync } = require('child_process');

function buildBookmarklet(jsFile) {
    const minified = execSync(`npx -y terser ${jsFile} --compress passes=2 --mangle`, {
        encoding: 'utf-8',
    }).trim();

    return 'javascript:void%20' + encodeURIComponent('(function(){' + minified + '})()');
}

const sorterBookmarklet = buildBookmarklet('mini-sorter.js');
const previewBookmarklet = buildBookmarklet('preview.js');

let html = fs.readFileSync('index.template.html', 'utf-8');
html = html.replace('{{MINI_SORTER_BOOKMARKLET}}', sorterBookmarklet);
html = html.replace('{{PDA_PREVIEW_BOOKMARKLET}}', previewBookmarklet);

fs.writeFileSync('index.html', html);
console.log('index.html generated successfully');
