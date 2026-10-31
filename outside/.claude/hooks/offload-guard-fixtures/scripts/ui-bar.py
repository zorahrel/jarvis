#!/usr/bin/env python3
# barra visiva con WebKit headless: nessuna parola "test" nel comando, ma apre un browser
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.webkit.launch()
    page = b.new_page()
    page.goto("http://127.0.0.1:3411/")
    page.screenshot(path="out.png")
    b.close()
