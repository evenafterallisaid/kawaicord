use url::Url;

pub fn external(url: &Url) -> bool {
    if matches!(url.scheme(), "https" | "http" | "mailto") {
        return true;
    }
    if url.scheme() != "spotify"
        || url.has_host()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    if url.path().is_empty() {
        return true;
    }
    let Some((kind, id)) = url.path().split_once(':') else {
        return false;
    };
    matches!(
        kind,
        "track" | "album" | "artist" | "playlist" | "episode" | "show"
    ) && id.len() == 22
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

// wkwebview sends subframe navigations through the same callback as the main
// document. captcha frames must stay embedded so their parent can receive the
// completion message. ipc permissions remain restricted to discord.com.
pub fn embedded(url: &Url) -> bool {
    if matches!(url.as_str(), "about:blank" | "about:srcdoc") {
        return true;
    }
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    url.host_str().is_some_and(|host| {
        matches!(
            host,
            "discord.com" | "ptb.discord.com" | "canary.discord.com"
        ) || host == "hcaptcha.com"
            || host.ends_with(".hcaptcha.com")
            || (host == "open.spotify.com"
                && (url.path() == "/embed" || url.path().starts_with("/embed/")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spotify_launch_links_reach_the_registered_app() {
        for value in [
            "spotify:",
            "spotify:track:0123456789abcdefghijkl",
            "spotify:playlist:0123456789abcdefghijkl",
            "https://open.spotify.com/track/example",
        ] {
            assert!(external(&Url::parse(value).unwrap()), "{value}");
        }
        for value in [
            "spotify://example.com",
            "spotify:track:bad",
            "spotify:track:0123456789abcdefghijkl?command=other",
            "spotify:app:other",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(!external(&Url::parse(value).unwrap()), "{value}");
        }
    }
    #[test]
    fn captcha_frames_stay_embedded() {
        for url in [
            "https://discord.com/login",
            "https://hcaptcha.com/",
            "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge",
            "https://regional.assets.hcaptcha.com/frame",
            "about:blank",
        ] {
            assert!(embedded(&Url::parse(url).unwrap()), "{url}");
        }
    }
    #[test]
    fn unrelated_links_and_lookalikes_stay_external() {
        for url in [
            "https://example.com/",
            "https://hcaptcha.com.evil.test/",
            "https://fakehcaptcha.com/",
            "http://hcaptcha.com/",
            "https://hcaptcha.com:8443/",
            "https://user@hcaptcha.com/",
            "https://open.spotify.com/track/0123456789abcdefghijkl",
            "https://open.spotify.com/embedevil/track/example",
            "https://open.spotify.com.evil.test/embed/track/example",
            "javascript:alert(1)",
        ] {
            assert!(!embedded(&Url::parse(url).unwrap()), "{url}");
        }
    }
    #[test]
    fn spotify_previews_are_embedded_without_becoming_external_actions() {
        for value in [
            "https://open.spotify.com/embed/track/0123456789abcdefghijkl",
            "https://open.spotify.com/embed/playlist/0123456789abcdefghijkl?utm_source=generator",
        ] {
            assert!(embedded(&Url::parse(value).unwrap()));
        }
    }
}
