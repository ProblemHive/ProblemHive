-- The site's name is written as one word now. The welcome post is the site's own text, so it follows;
-- other posts and comments keep the spelling their authors used.
UPDATE posts SET
  title = replace(title, 'Problem Hive', 'ProblemHive'),
  summary = replace(summary, 'Problem Hive', 'ProblemHive')
WHERE title = 'Welcome: how Problem Hive works';
