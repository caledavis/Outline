//! Searching the user's Zotero library.
//!
//! Zotero 7 has a "local API": while Zotero is open, it answers requests from
//! this computer at http://127.0.0.1:23119/api/, in the same format as the
//! Zotero web API (https://www.zotero.org/support/dev/web_api/v3/basics).
//! It must be switched on in Zotero → Settings → Advanced → "Allow other
//! applications on this computer to communicate with Zotero".

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const API_URL: &str = "http://127.0.0.1:23119/api";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub key: String,
    pub title: String,
    /// E.g. "Smith and Jones" or "Smith et al."
    pub creators: String,
    pub year: String,
    pub item_type: String,
    /// Opens the item in Zotero.
    pub uri: String,
}

/// Finds items whose title, creators or year match the query (or the most
/// recently changed items, if the query is empty).
pub fn search(query: &str) -> Result<Vec<Item>, String> {
    // "users/0" is the user's own library.
    let mut query_pairs = vec![("limit", "30"), ("sort", "dateModified")];
    if !query.trim().is_empty() {
        query_pairs.extend([("q", query.trim()), ("qmode", "titleCreatorYear")]);
    }
    let items = get("users/0/items/top", &query_pairs)?;
    Ok(items.iter().filter_map(item_from).collect())
}

/// The notes attached to a Zotero item (as HTML), given its zotero://select/… link.
pub fn notes(uri: &str) -> Result<Vec<String>, String> {
    let item = api_path(uri).ok_or("That isn't a link to a Zotero item.")?;
    let children = get(&format!("{item}/children"), &[("itemType", "note")])?;
    Ok(children
        .iter()
        .filter(|child| child["data"]["itemType"] == "note")
        .filter_map(|child| child["data"]["note"].as_str().map(String::from))
        .collect())
}

/// Requests a list of items from the local API.
fn get(path: &str, query: &[(&str, &str)]) -> Result<Vec<Value>, String> {
    let mut request = ureq::get(format!("{API_URL}/{path}"))
        .header("Zotero-API-Version", "3")
        .query("format", "json")
        .config()
        .timeout_global(Some(Duration::from_secs(10)))
        .build();
    for (key, value) in query {
        request = request.query(*key, *value);
    }
    request
        .call()
        .map_err(describe_error)?
        .body_mut()
        .read_json()
        .map_err(|e| format!("Zotero sent an unexpected reply: {e}"))
}

/// Turns a zotero://select/… link into the item's path in the local API.
fn api_path(uri: &str) -> Option<String> {
    let parts: Vec<&str> = uri.strip_prefix("zotero://select/")?.split('/').collect();
    let is_key = |key: &str| !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric());
    let is_number = |id: &str| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit());
    match parts.as_slice() {
        ["library", "items", key] if is_key(key) => Some(format!("users/0/items/{key}")),
        ["groups", id, "items", key] if is_number(id) && is_key(key) => Some(format!("groups/{id}/items/{key}")),
        _ => None,
    }
}

fn describe_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::StatusCode(403) => "Zotero isn't allowing other apps to read your library. In Zotero, open \
             Settings → Advanced and tick “Allow other applications on this computer to communicate with Zotero”."
            .into(),
        ureq::Error::StatusCode(code) => format!("Zotero replied with an error ({code})."),
        _ => "Couldn't reach Zotero. Make sure Zotero 7 or later is open.".into(),
    }
}

fn item_from(value: &Value) -> Option<Item> {
    let data = &value["data"];
    let item_type = data["itemType"].as_str()?;
    // Notes and files stored on their own aren't things you'd cite.
    if matches!(item_type, "note" | "attachment" | "annotation") {
        return None;
    }
    let key = value["key"].as_str()?.to_string();
    let title = data["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("Untitled").to_string();
    let creators = value["meta"]["creatorSummary"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| creator_summary(&data["creators"]));
    let year = value["meta"]["parsedDate"]
        .as_str()
        .or(data["date"].as_str())
        .map(year_of)
        .unwrap_or_default();
    let uri = match (value["library"]["type"].as_str(), value["library"]["id"].as_u64()) {
        (Some("group"), Some(id)) => format!("zotero://select/groups/{id}/items/{key}"),
        _ => format!("zotero://select/library/items/{key}"),
    };
    Some(Item { key, title, creators, year, item_type: item_type.to_string(), uri })
}

/// "Smith", "Smith and Jones" or "Smith et al.", like Zotero itself shows.
fn creator_summary(creators: &Value) -> String {
    let names: Vec<&str> = creators
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|c| c["lastName"].as_str().or(c["name"].as_str()))
                .collect()
        })
        .unwrap_or_default();
    match names.as_slice() {
        [] => String::new(),
        [one] => one.to_string(),
        [first, second] => format!("{first} and {second}"),
        [first, ..] => format!("{first} et al."),
    }
}

/// The first four-digit number in a date such as "2021-03-01" or "March 2021".
fn year_of(date: &str) -> String {
    date.split(|c: char| !c.is_ascii_digit())
        .find(|part| part.len() == 4)
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Needs Zotero open with its local API on: `cargo test -- --ignored live`
    #[test]
    #[ignore]
    fn live_search() {
        for query in ["", "hello"] {
            let items = search(query).unwrap();
            println!("{query:?}: {items:#?}");
            for item in &items {
                println!("notes for {}: {:?}", item.key, notes(&item.uri).unwrap());
            }
        }
    }

    #[test]
    fn turns_links_into_api_paths() {
        assert_eq!(api_path("zotero://select/library/items/AB12CD34").unwrap(), "users/0/items/AB12CD34");
        assert_eq!(api_path("zotero://select/groups/42/items/AB12CD34").unwrap(), "groups/42/items/AB12CD34");
        assert_eq!(api_path("zotero://select/library/items/../../x"), None);
        assert_eq!(api_path("zotero://select/groups/x/items/AB12CD34"), None);
        assert_eq!(api_path("https://example.com"), None);
    }

    #[test]
    fn reads_items_in_zotero_api_format() {
        let reply = json!([
            {
                "key": "ABCD2345",
                "library": { "type": "user", "id": 123 },
                "meta": { "creatorSummary": "Smith and Jones", "parsedDate": "2021-03-01" },
                "data": { "itemType": "journalArticle", "title": "On outlines", "date": "March 1, 2021" }
            },
            {
                "key": "EFGH6789",
                "library": { "type": "group", "id": 42 },
                "meta": {},
                "data": {
                    "itemType": "book",
                    "title": "",
                    "date": "Spring 1998",
                    "creators": [{ "lastName": "Lee" }, { "name": "OECD" }, { "lastName": "Park" }]
                }
            },
            { "key": "NOTE0001", "library": {}, "data": { "itemType": "note" } }
        ]);
        let items: Vec<Item> = reply.as_array().unwrap().iter().filter_map(item_from).collect();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].creators, "Smith and Jones");
        assert_eq!(items[0].year, "2021");
        assert_eq!(items[0].uri, "zotero://select/library/items/ABCD2345");
        assert_eq!(items[1].title, "Untitled");
        assert_eq!(items[1].creators, "Lee et al.");
        assert_eq!(items[1].year, "1998");
        assert_eq!(items[1].uri, "zotero://select/groups/42/items/EFGH6789");
    }
}
