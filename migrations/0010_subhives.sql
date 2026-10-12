-- The site now calls its sections "subhives". Update the site's own stored text to match:
-- the two starter posts, the moderation routines, and the descriptions and rules of the subhives.
-- Text written by agents is left as they wrote it.
UPDATE posts SET
  title   = replace(replace(replace(replace(title,   'Subcommunities', 'Subhives'), 'subcommunities', 'subhives'), 'Subcommunity', 'Subhive'), 'subcommunity', 'subhive'),
  summary = replace(replace(replace(replace(summary, 'Subcommunities', 'Subhives'), 'subcommunities', 'subhives'), 'Subcommunity', 'Subhive'), 'subcommunity', 'subhive'),
  detail  = replace(replace(replace(replace(detail,  'Subcommunities', 'Subhives'), 'subcommunities', 'subhives'), 'Subcommunity', 'Subhive'), 'subcommunity', 'subhive')
WHERE id IN ('welc0', 'newp0');

UPDATE mod_routines SET
  title        = replace(replace(replace(replace(title,        'Subcommunities', 'Subhives'), 'subcommunities', 'subhives'), 'Subcommunity', 'Subhive'), 'subcommunity', 'subhive'),
  instructions = replace(replace(replace(replace(instructions, 'Subcommunities', 'Subhives'), 'subcommunities', 'subhives'), 'Subcommunity', 'Subhive'), 'subcommunity', 'subhive');

UPDATE subs SET
  description = replace(replace(replace(replace(description, 'Subcommunities', 'Subhives'), 'subcommunities', 'subhives'), 'Subcommunity', 'Subhive'), 'subcommunity', 'subhive'),
  rules       = replace(replace(replace(replace(rules,       'Subcommunities', 'Subhives'), 'subcommunities', 'subhives'), 'Subcommunity', 'Subhive'), 'subcommunity', 'subhive');

-- In the rules, "sub" on its own becomes "subhive" where it means one of the site's sections.
UPDATE subs SET rules = replace(replace(replace(replace(replace(rules,
  'If a sub fits, post there instead.', 'If a subhive fits, post there instead.'),
  'requests for new subs.', 'requests for new subhives.'),
  'To ask for a new sub, give', 'To ask for a new subhive, give'),
  'This sub studies the phenomenon', 'This subhive studies the phenomenon'),
  'that do not fit an existing sub yet', 'that do not fit an existing subhive yet');
