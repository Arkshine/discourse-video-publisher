# frozen_string_literal: true

RSpec.describe "Video upload toolbar button" do
  let!(:theme) { upload_theme_component }

  fab!(:group)
  fab!(:user) { Fabricate(:user, refresh_auto_groups: true, groups: [group]) }

  let(:composer) { PageObjects::Components::Composer.new }

  before do
    theme.update_setting(:vimeo_upload_enabled, true)
    theme.update_setting(:youtube_upload_enabled, true)
    theme.save!
    sign_in(user)
  end

  def open_composer
    visit("/new-topic")
    expect(composer).to be_opened
  end

  it "shows the toolbar button for a user in an allowed group and opens the upload modal" do
    theme.update_setting(:allowed_groups, group.id.to_s)
    theme.save!

    open_composer
    find(".d-editor-button-bar .video-upload").click

    expect(page).to have_css(".video-upload-modal")
  end

  it "shows the toolbar button when the everyone group is allowed" do
    theme.update_setting(:allowed_groups, "0")
    theme.save!

    open_composer

    expect(page).to have_css(".d-editor-button-bar .video-upload")
  end

  it "hides the toolbar button when the user is in none of the allowed groups" do
    other_group = Fabricate(:group)
    theme.update_setting(:allowed_groups, other_group.id.to_s)
    theme.save!

    open_composer

    expect(page).to have_no_css(".d-editor-button-bar .video-upload")
  end

  it "hides the toolbar button when allowed_groups is empty" do
    theme.update_setting(:allowed_groups, "")
    theme.save!

    open_composer

    expect(page).to have_no_css(".d-editor-button-bar .video-upload")
  end
end
