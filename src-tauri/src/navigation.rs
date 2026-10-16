use url::Url;

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
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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
            "javascript:alert(1)",
        ] {
            assert!(!embedded(&Url::parse(url).unwrap()), "{url}");
        }
    }
}
