import re
import os

files = ['popup/flow.js', 'popup/component.js']
for file in files:
    with open(file, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    content = re.sub(r"infoBtn\.innerHTML\s*=\s*['\"].*?Info['\"];", "infoBtn.innerHTML = 'ⓘ&nbsp;Info';", content)
    content = re.sub(r"icon\.textContent\s*=\s*['\"].*?['\"];", "icon.textContent = 'ⓘ';", content)
    content = re.sub(r"editBtn\.textContent\s*=\s*['\"].*?['\"];", "editBtn.textContent = '✏️';", content)
    content = re.sub(r"dupBtn\.textContent\s*=\s*['\"].*?['\"];", "dupBtn.textContent = '📋';", content)
    content = re.sub(r"delBtn\.textContent\s*=\s*['\"].*?['\"];", "delBtn.textContent = '🗑';", content)
    content = re.sub(r"footer\.textContent\s*=\s*['\"].*?Not executed['\"];", "footer.textContent = 'ⓘ Information only · Not executed';", content)
    content = re.sub(r"iconEl\.textContent\s*=\s*['\"].*?['\"];", "iconEl.textContent = 'ⓘ';", content)

    with open(file, 'w', encoding='utf-8') as f:
        f.write(content)

print("Fixed using Python!")
