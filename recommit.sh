#!/bin/bash
rm -rf .git
git init
git config user.name "jerryt92"
git config user.mail "jerrytian92@outlook.com"
git config user.name
git add .
git commit -m 'first commit'
git branch -M main
git remote add origin https://github.com/jerryt92/live-photo-creator.git
git push -u origin main -f
