"""
Instagram publish test — a minimal local interface to:
  1. Connect an Instagram Business/Creator account (paste an access token)
  2. Publish a single image post to it

This is a walking skeleton to prove the publishing mechanic works before
building the real app. It skips full OAuth (you paste a token from the Graph
API Explorer / Instagram token generator) to stay quick.

Two API modes are supported (set API_MODE in .env):
  - "instagram" : Instagram API with Instagram Login  -> graph.instagram.com
  - "facebook"  : Instagram API with Facebook Login    -> graph.facebook.com
                  (the old "Instagram Graph API"; requires a linked FB Page)

Run:
  pip install -r requirements.txt
  cp .env.example .env   # then paste your token into it (optional)
  python app.py
  open http://localhost:5000
"""

import os
import time

import requests
from dotenv import load_dotenv
from flask import Flask, redirect, render_template_string, request, session, url_for

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET", "dev-secret-change-me")

GRAPH_VERSION = os.environ.get("GRAPH_VERSION", "v21.0")
API_MODE = os.environ.get("API_MODE", "instagram").lower()  # "instagram" | "facebook"
API_HOST = "graph.instagram.com" if API_MODE == "instagram" else "graph.facebook.com"
BASE = f"https://{API_HOST}/{GRAPH_VERSION}"

# Optional: prefill the token/account from env so you don't paste every run.
ENV_TOKEN = os.environ.get("ACCESS_TOKEN", "")
ENV_IG_USER_ID = os.environ.get("IG_USER_ID", "")


# --------------------------------------------------------------------------- #
# Graph API helpers
# --------------------------------------------------------------------------- #
class GraphError(Exception):
    """Raised when the Graph API returns an error payload."""


def _check(resp):
    """Return parsed JSON or raise GraphError with Meta's message."""
    data = resp.json()
    if isinstance(data, dict) and data.get("error"):
        err = data["error"]
        raise GraphError(f"{err.get('type')}: {err.get('message')} (code {err.get('code')})")
    resp.raise_for_status()
    return data


def resolve_account(token):
    """
    Return (ig_user_id, display_name) for the given token.

    - instagram mode: /me exposes the IG user_id + username directly.
    - facebook mode:  find a Page, then its linked instagram_business_account.
    If IG_USER_ID is set in env we trust it and just fetch the username.
    """
    if API_MODE == "instagram":
        me = _check(requests.get(
            f"{BASE}/me",
            params={"fields": "user_id,username", "access_token": token},
            timeout=30,
        ))
        # Some tokens key this as "user_id", others as "id" — accept either.
        ig_id = ENV_IG_USER_ID or str(me.get("user_id") or me.get("id"))
        return ig_id, me.get("username", ig_id)

    # facebook mode
    if ENV_IG_USER_ID:
        prof = _check(requests.get(
            f"{BASE}/{ENV_IG_USER_ID}",
            params={"fields": "username", "access_token": token},
            timeout=30,
        ))
        return ENV_IG_USER_ID, prof.get("username", ENV_IG_USER_ID)

    pages = _check(requests.get(
        f"{BASE}/me/accounts",
        params={"fields": "name,instagram_business_account", "access_token": token},
        timeout=30,
    )).get("data", [])
    for page in pages:
        iba = page.get("instagram_business_account")
        if iba:
            ig_id = iba["id"]
            prof = _check(requests.get(
                f"{BASE}/{ig_id}",
                params={"fields": "username", "access_token": token},
                timeout=30,
            ))
            return ig_id, prof.get("username", ig_id)
    raise GraphError(
        "No Instagram Business account found on any Page for this token. "
        "Confirm the account is Business/Creator and linked to a Facebook Page."
    )


def publish_image(token, ig_user_id, image_url, caption):
    """Create a media container, wait for it to be ready, then publish it."""
    # 1. Create container
    container = _check(requests.post(
        f"{BASE}/{ig_user_id}/media",
        data={"image_url": image_url, "caption": caption, "access_token": token},
        timeout=60,
    ))
    creation_id = container["id"]

    # 2. Wait until the container finishes processing (images are usually
    #    instant; poll a few times to be safe).
    for _ in range(10):
        status = _check(requests.get(
            f"{BASE}/{creation_id}",
            params={"fields": "status_code", "access_token": token},
            timeout=30,
        ))
        code = status.get("status_code")
        if code == "FINISHED":
            break
        if code == "ERROR":
            raise GraphError("Media container processing failed (status ERROR).")
        time.sleep(2)

    # 3. Publish
    published = _check(requests.post(
        f"{BASE}/{ig_user_id}/media_publish",
        data={"creation_id": creation_id, "access_token": token},
        timeout=60,
    ))
    return published["id"]


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
PAGE = """
<!doctype html>
<title>Instagram Publish Test</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 620px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 20px; }
  .card { border: 1px solid #e3e3e3; border-radius: 10px; padding: 20px; margin: 16px 0; }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  input, textarea { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 6px; font: inherit; box-sizing: border-box; }
  button { margin-top: 14px; padding: 9px 16px; border: 0; border-radius: 6px; background: #405de6; color: #fff; font-weight: 600; cursor: pointer; }
  .ok { color: #0a7d29; } .err { color: #c00; }
  .muted { color: #777; font-size: 13px; }
  code { background: #f3f3f3; padding: 1px 5px; border-radius: 4px; }
  a.link { color: #405de6; }
</style>

<h1>📸 Instagram Publish Test</h1>
<p class="muted">Mode: <code>{{ mode }}</code> · Host: <code>{{ host }}</code> · API {{ version }}</p>

{% if message %}<p class="{{ 'ok' if success else 'err' }}">{{ message }}</p>{% endif %}

{% if not connected %}
<div class="card">
  <h2 style="font-size:16px;margin-top:0">1 · Connect</h2>
  <p class="muted">Paste an access token from the Graph API Explorer (or the Instagram
  token generator on your app's setup page). Needs <code>instagram_business_content_publish</code>.</p>
  <form method="post" action="{{ url_for('connect') }}">
    <label>Access token</label>
    <input name="token" value="{{ prefill_token }}" placeholder="EAAG..." autocomplete="off">
    <button type="submit">Connect</button>
  </form>
</div>
{% else %}
<div class="card">
  <h2 style="font-size:16px;margin-top:0">✅ Connected</h2>
  <p>Account: <b>@{{ username }}</b> &nbsp;<span class="muted">(id {{ ig_user_id }})</span></p>
  <a class="link" href="{{ url_for('disconnect') }}">Disconnect</a>
</div>

<div class="card">
  <h2 style="font-size:16px;margin-top:0">2 · Publish a post</h2>
  <p class="muted">Instagram fetches the image from a <b>public URL</b> — you can't upload a
  local file. Any public image URL works for the test.</p>
  <form method="post" action="{{ url_for('publish') }}">
    <label>Public image URL</label>
    <input name="image_url" value="https://picsum.photos/1080" required>
    <label>Caption</label>
    <textarea name="caption" rows="3">Hello from my Instagram agent test 🚀</textarea>
    <button type="submit">Publish now</button>
  </form>
</div>
{% endif %}
"""


@app.route("/")
def index():
    return render_template_string(
        PAGE,
        connected="token" in session,
        username=session.get("username"),
        ig_user_id=session.get("ig_user_id"),
        prefill_token=ENV_TOKEN,
        mode=API_MODE,
        host=API_HOST,
        version=GRAPH_VERSION,
        message=request.args.get("message"),
        success=request.args.get("success") == "1",
    )


@app.route("/connect", methods=["POST"])
def connect():
    token = (request.form.get("token") or "").strip()
    if not token:
        return redirect(url_for("index", message="Please paste a token.", success=0))
    try:
        ig_user_id, username = resolve_account(token)
    except (GraphError, requests.RequestException) as e:
        return redirect(url_for("index", message=f"Connect failed: {e}", success=0))
    session["token"] = token
    session["ig_user_id"] = ig_user_id
    session["username"] = username
    return redirect(url_for("index", message=f"Connected as @{username}.", success=1))


@app.route("/publish", methods=["POST"])
def publish():
    if "token" not in session:
        return redirect(url_for("index", message="Connect first.", success=0))
    image_url = (request.form.get("image_url") or "").strip()
    caption = request.form.get("caption") or ""
    try:
        post_id = publish_image(session["token"], session["ig_user_id"], image_url, caption)
    except (GraphError, requests.RequestException) as e:
        return redirect(url_for("index", message=f"Publish failed: {e}", success=0))
    return redirect(url_for("index", message=f"Published! Media id {post_id}", success=1))


@app.route("/disconnect")
def disconnect():
    session.clear()
    return redirect(url_for("index"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))  # 5000 is taken by macOS AirPlay Receiver
    print(f"\n  Instagram publish test → http://localhost:{port}  (mode={API_MODE}, host={API_HOST})\n")
    app.run(host="127.0.0.1", port=port, debug=True)
