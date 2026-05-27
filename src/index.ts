#!/usr/bin/env node

const inputName = process.argv.slice(2).join(" ").trim();
const name = inputName.length > 0 ? inputName : "World";

console.log(`Hello, ${name}!`);
