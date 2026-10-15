#!/usr/bin/env python3
"""Ready up all party members and start the Rogue One table."""
import json
import time
import urllib.request
import urllib.error
import http.cookiejar

BASE = "http://neo.home:3210"
CID = "f8290a31-39b7-4ee7-bc6f-ca923ab264ee"
CREDS = json.load(open("/tmp/sw5e-party-creds.json"))["users"]


class CookieSession:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, path, method="GET", body=None):
        r = urllib.request.Request(BASE + path, method=method,
                                   data=json.dumps(body).encode() if body else None,
                                   headers={"Content-Type": "application/json"})
        try:
            return json.load(self.opener.open(r, timeout=30)), None
        except urllib.error.HTTPError as e:
            return None, {"code": e.code, "body": e.read()[:200].decode(errors="replace")}


for user, pw in CREDS.items():
    s = CookieSession()
    body, err = s.call("/api/auth/login", "POST", {"username": user, "password": pw})
    if err:
        print(f"{user}: login {err}")
        continue
    _, jerr = s.call(f"/api/campaigns/{CID}/ready", "POST", {"ready": True})
    print(f"{user}: ready {'ok' if not jerr else jerr}")
    time.sleep(8)

admin = open("/tmp/odm-sw5e-token.txt").read().strip()
r = urllib.request.Request(BASE + f"/api/campaigns/{CID}/ready", method="POST",
                           data=json.dumps({"ready": True}).encode(),
                           headers={"Authorization": "Bearer " + admin,
                                    "Content-Type": "application/json"})
print("owner ready:", json.load(urllib.request.urlopen(r, timeout=30)))

r = urllib.request.Request(BASE + f"/api/campaigns/{CID}", method="PATCH",
                           data=json.dumps({"status": "active"}).encode(),
                           headers={"Authorization": "Bearer " + admin,
                                    "Content-Type": "application/json"})
d = json.load(urllib.request.urlopen(r, timeout=60))
print("status:", d.get("status"))
